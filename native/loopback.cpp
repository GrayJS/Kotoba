// Windows process-loopback capture. stdout is JSON (--list) or raw PCM (--pid).
// PCM contract: signed little-endian int16, 48000 Hz, two channels.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <tlhelp32.h>
#include <wrl.h>
#include <wrl/implements.h>
#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <vector>
#include <sstream>
#include <stdexcept>
using Microsoft::WRL::ComPtr;

struct Handle {
    HANDLE value = nullptr;
    explicit Handle(HANDLE h = nullptr) : value(h) {}
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle(const Handle&) = delete;
};
void check(HRESULT hr, const char* step) {
    if (FAILED(hr)) { std::ostringstream s; s << step << " (HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << ")"; throw std::runtime_error(s.str()); }
}
std::string utf8(const std::wstring& value) {
    if (value.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(n, '\0'); WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), n, nullptr, nullptr); return result;
}
std::string json(const std::string& text) {
    std::string out = "\"";
    for (unsigned char c : text) {
        if (c == '"' || c == '\\') { out += '\\'; out += c; }
        else if (c < 32) { char escaped[8]; sprintf_s(escaped, "\\u%04x", c); out += escaped; }
        else out += c;
    }
    return out + "\"";
}
std::wstring image(DWORD pid) {
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
    wchar_t path[32768]; DWORD length = 32768;
    if (!process.value || !QueryFullProcessImageNameW(process.value, 0, path, &length)) return L"";
    std::wstring full(path, length); auto pos = full.find_last_of(L"\\/"); return full.substr(pos == std::wstring::npos ? 0 : pos + 1);
}
struct Process { DWORD parent; std::wstring name; };
std::map<DWORD, Process> processTable() {
    std::map<DWORD, Process> result;
    Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
    PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
    if (snapshot.value != INVALID_HANDLE_VALUE && Process32FirstW(snapshot.value, &entry)) {
        do { result.emplace(entry.th32ProcessID, Process{entry.th32ParentProcessID, entry.szExeFile}); } while (Process32NextW(snapshot.value, &entry));
    }
    return result;
}
DWORD rootOf(DWORD pid, const std::map<DWORD, Process>& table) {
    std::set<DWORD> visited;
    while (visited.insert(pid).second) {
        auto it = table.find(pid); if (it == table.end()) break;
        auto parent = table.find(it->second.parent);
        if (parent == table.end() || _wcsicmp(parent->second.name.c_str(), it->second.name.c_str()) != 0) break;
        pid = parent->first;
    }
    return pid;
}
BOOL CALLBACK windowTitle(HWND hwnd, LPARAM arg) {
    auto& titles = *reinterpret_cast<std::map<DWORD, std::wstring>*>(arg);
    if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER)) return TRUE;
    wchar_t title[1024]{}; GetWindowTextW(hwnd, title, 1024);
    DWORD pid{}; GetWindowThreadProcessId(hwnd, &pid);
    if (title[0] && !titles.count(pid)) titles.emplace(pid, title);
    return TRUE;
}
void listApps() {
    const auto table = processTable(); std::map<DWORD, std::wstring> titles; EnumWindows(windowTitle, reinterpret_cast<LPARAM>(&titles));
    std::map<DWORD, bool> apps;
    ComPtr<IMMDeviceEnumerator> devices; check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&devices)), "Create device enumerator");
    ComPtr<IMMDeviceCollection> endpoints; check(devices->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &endpoints), "Enumerate output devices");
    UINT count{}; check(endpoints->GetCount(&count), "Get device count");
    for (UINT i = 0; i < count; ++i) {
        ComPtr<IMMDevice> device; if (FAILED(endpoints->Item(i, &device))) continue;
        ComPtr<IAudioSessionManager2> manager; if (FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, &manager))) continue;
        ComPtr<IAudioSessionEnumerator> sessions; if (FAILED(manager->GetSessionEnumerator(&sessions))) continue;
        int length{}; sessions->GetCount(&length);
        for (int j = 0; j < length; ++j) {
            ComPtr<IAudioSessionControl> session; ComPtr<IAudioSessionControl2> control;
            if (FAILED(sessions->GetSession(j, &session)) || FAILED(session.As(&control))) continue;
            DWORD pid{}; AudioSessionState state{};
            if (FAILED(control->GetProcessId(&pid)) || !pid || FAILED(session->GetState(&state)) || state == AudioSessionStateExpired) continue;
            pid = rootOf(pid, table); apps[pid] = apps[pid] || state == AudioSessionStateActive;
        }
    }
    std::cout << '['; bool first = true;
    for (auto [pid, active] : apps) {
        auto name = image(pid); if (name.empty() || name == L"loopback.exe" || name == L"Kotoba 字幕.exe") continue;
        if (!first) std::cout << ','; first = false;
        std::cout << "{\"pid\":" << pid << ",\"name\":" << json(utf8(name)) << ",\"title\":" << json(utf8(titles[pid])) << ",\"active\":" << (active ? "true" : "false") << '}';
    }
    std::cout << "]\n";
}
class Activation final : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler> {
public:
    Handle done{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    HRESULT result = E_PENDING;
    ComPtr<IAudioClient> client;
    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
        ComPtr<IUnknown> unknown; HRESULT activated = E_FAIL;
        result = operation->GetActivateResult(&activated, &unknown);
        if (SUCCEEDED(result)) result = activated;
        if (SUCCEEDED(result)) result = unknown.As(&client);
        SetEvent(done.value); return S_OK;
    }
};
void writePcm(const BYTE* bytes, DWORD length) {
    HANDLE pipe = GetStdHandle(STD_OUTPUT_HANDLE);
    while (length) { DWORD written{}; if (!WriteFile(pipe, bytes, length, &written, nullptr) || !written) throw std::runtime_error("Audio consumer disconnected"); bytes += written; length -= written; }
}
void capture(DWORD pid, DWORD parent) {
    Handle target(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
    Handle owner(OpenProcess(SYNCHRONIZE, FALSE, parent));
    if (!target.value || !owner.value) throw std::runtime_error("Cannot access selected process; select a running non-elevated application");
    auto activation = Microsoft::WRL::Make<Activation>();
    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT variant{}; variant.vt = VT_BLOB; variant.blob.cbSize = sizeof(params); variant.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    check(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &variant, activation.Get(), &operation), "Activate process loopback");
    if (WaitForSingleObject(activation->done.value, 10000) != WAIT_OBJECT_0) throw std::runtime_error("Audio activation timed out");
    check(activation->result, "Complete audio activation");
    auto client = activation->client;
    WAVEFORMATEX format{}; format.wFormatTag = WAVE_FORMAT_PCM; format.nChannels = 2; format.nSamplesPerSec = 48000; format.wBitsPerSample = 16; format.nBlockAlign = 4; format.nAvgBytesPerSec = 192000;
    check(client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, 0, 0, &format, nullptr), "Initialize audio stream");
    Handle samples(CreateEventW(nullptr, FALSE, FALSE, nullptr)); check(client->SetEventHandle(samples.value), "Set audio event");
    ComPtr<IAudioCaptureClient> reader; check(client->GetService(IID_PPV_ARGS(&reader)), "Get capture service");
    check(client->Start(), "Start capture");
    std::cerr << "{\"type\":\"capture_ready\",\"rate\":48000,\"channels\":2,\"format\":\"s16le\"}\n" << std::flush;
    HANDLE events[] = { target.value, owner.value, samples.value };
    std::vector<BYTE> silence(19200, 0);
    bool targetExited = false;
    try {
        for (;;) {
            auto status = WaitForMultipleObjects(3, events, FALSE, 100);
            if (status == WAIT_OBJECT_0) { targetExited = true; break; }
            if (status == WAIT_OBJECT_0 + 1) break;
            if (status == WAIT_FAILED) throw std::runtime_error("Audio wait failed");
            if (status == WAIT_TIMEOUT) { writePcm(silence.data(), static_cast<DWORD>(silence.size())); continue; }
            UINT32 available{}; check(reader->GetNextPacketSize(&available), "Get audio packet");
            while (available) {
                BYTE* data{}; UINT32 frames{}; DWORD flags{};
                check(reader->GetBuffer(&data, &frames, &flags, nullptr, nullptr), "Read audio packet");
                const DWORD bytes = frames * format.nBlockAlign;
                try {
                    if (flags & AUDCLNT_BUFFERFLAGS_SILENT) { std::vector<BYTE> zeros(bytes, 0); writePcm(zeros.data(), bytes); }
                    else writePcm(data, bytes);
                } catch (...) { reader->ReleaseBuffer(frames); throw; }
                check(reader->ReleaseBuffer(frames), "Release audio packet");
                check(reader->GetNextPacketSize(&available), "Get next audio packet");
            }
        }
    } catch (...) { client->Stop(); throw; }
    client->Stop();
    if (targetExited) std::cerr << "{\"type\":\"target_exited\"}\n" << std::flush;
}
int wmain(int argc, wchar_t** argv) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX); _setmode(_fileno(stdout), _O_BINARY);
    HRESULT init = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    try {
        check(init, "Initialize COM");
        if (argc == 2 && std::wstring(argv[1]) == L"--list") listApps();
        else if (argc == 5 && std::wstring(argv[1]) == L"--pid" && std::wstring(argv[3]) == L"--parent") capture(std::stoul(argv[2]), std::stoul(argv[4]));
        else throw std::runtime_error("Usage: loopback --list | --pid PID --parent OWNER_PID");
        CoUninitialize(); return 0;
    } catch (const std::exception& error) {
        std::cerr << "{\"type\":\"capture_error\",\"message\":" << json(error.what()) << "}\n" << std::flush;
        if (SUCCEEDED(init)) CoUninitialize(); return 1;
    }
}
