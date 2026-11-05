using System;
using System.Media;
using System.Threading;
// Integration-test audio source, excluded from the application package.
class TonePlayer {
    static void Main(string[] args) {
        using (var player = new SoundPlayer(args[0])) {
            player.Load(); player.PlayLooping();
            Thread.Sleep(Int32.Parse(args[1])); player.Stop(); Thread.Sleep(5000);
        }
    }
}
