import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
interface Encryption { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }

// On Windows Electron safeStorage uses DPAPI, scoped to the Windows account.
// Credentials are bound to an exact endpoint; editing the address never sends an old key to a new host.
export class SecretStore {
  constructor(private file: string, private crypto: Encryption) {}
  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    if (!this.crypto.isEncryptionAvailable()) throw new Error('Windows 密钥加密不可用，请检查当前用户账户');
    try { return JSON.parse(this.crypto.decryptString(readFileSync(this.file))); }
    catch { throw new Error('无法解密已保存的密钥，请在服务设置中重新填写'); }
  }
  get(endpoint: string) { return this.read()[endpoint] || ''; }
  set(endpoint: string, value: string) {
    if (!this.crypto.isEncryptionAvailable()) throw new Error('Windows 密钥加密不可用，未保存密钥');
    const keys = this.read(); if (value) keys[endpoint] = value; else delete keys[endpoint];
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file + '.tmp', this.crypto.encryptString(JSON.stringify(keys)));
    renameSync(this.file + '.tmp', this.file);
  }
}
