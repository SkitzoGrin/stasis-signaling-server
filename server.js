using System;
using System.Buffers.Binary;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

// === Top-level receiver ===

const int Port = 55444;
const int TargetFps = 30;

// Point to ffmpeg (falls back to PATH if this file isn't found)
string ffmpegPath = @"C:\ffmpeg\bin\ffmpeg.exe";
if (!File.Exists(ffmpegPath)) ffmpegPath = "ffmpeg";

Console.Title = "Stasis Receiver";
var cts = new CancellationTokenSource();
Console.CancelKeyPress += (s, e) => { e.Cancel = true; cts.Cancel(); };

var listener = new TcpListener(IPAddress.Any, Port);
listener.Start();

while (!cts.IsCancellationRequested)
{
    Console.WriteLine("Waiting for phone to connect...");

    TcpClient? client = null;
    try
    {
        client = await listener.AcceptTcpClientAsync(cts.Token);
    }
    catch (OperationCanceledException)
    {
        break;
    }

    var remote = client.Client.RemoteEndPoint?.ToString() ?? "client";
    Console.WriteLine($"Connected: {remote}");

    // Create session folder: Videos/Stasis/YYYY-MM-DD/session-HHmmss
    var dayRoot = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.MyVideos),
        "Stasis",
        DateTime.Now.ToString("yyyy-MM-dd"));
    Directory.CreateDirectory(dayRoot);

    ReceiverState.CurrentSessionDir = Path.Combine(dayRoot, $"session-{DateTime.Now:HHmmss}");
    Directory.CreateDirectory(ReceiverState.CurrentSessionDir);
    ReceiverState.FrameIndex = 0;

    Console.WriteLine($"Writing frames to: {ReceiverState.CurrentSessionDir}");

    try
    {
        using var ns = client.GetStream();
        var lenBuf = new byte[4];

        // Read loop: 4-byte big-endian length + JPEG bytes
        while (await NetUtil.ReadExactAsync(ns, lenBuf, 4, cts.Token))
        {
            int length = BinaryPrimitives.ReadInt32BigEndian(lenBuf);
            if (length <= 0 || length > 50_000_000)
            {
                Console.WriteLine($"Bad frame length {length}. Closing.");
                break;
            }

            var jpeg = new byte[length];
            if (!await NetUtil.ReadExactAsync(ns, jpeg, length, cts.Token))
            {
                Console.WriteLine("Stream ended while reading frame.");
                break;
            }

            ReceiverState.SaveFrame(jpeg);
        }
    }
    catch (OperationCanceledException) { }
    catch (Exception ex)
    {
        Console.WriteLine("Error while receiving: " + ex.Message);
    }
    finally
    {
        try { client.Close(); } catch { }
        Console.WriteLine("Connection closed by peer.");
        await VideoEncoder.EncodeAndCleanAsync(ReceiverState.CurrentSessionDir, TargetFps, ffmpegPath);
    }
}

// === Helpers & state (types can appear after top-level code) ===

static class ReceiverState
{
    public static string CurrentSessionDir = "";
    public static int FrameIndex = 0;

    // Save each frame as 000000.jpg, 000001.jpg, ...
    public static void SaveFrame(byte[] jpegBytes)
    {
        var path = Path.Combine(CurrentSessionDir, $"{FrameIndex:D6}.jpg");
        File.WriteAllBytes(path, jpegBytes);
        Interlocked.Increment(ref FrameIndex);
    }
}

static class NetUtil
{
    // Reads exactly 'count' bytes; returns false if stream ends early.
    public static async Task<bool> ReadExactAsync(Stream s, byte[] buffer, int count, CancellationToken ct)
    {
        int offset = 0;
        while (offset < count)
        {
            int read = await s.ReadAsync(buffer.AsMemory(offset, count - offset), ct);
            if (read == 0) return false; // EOF
            offset += read;
        }
        return true;
    }
}

static class VideoEncoder
{
    public static async Task EncodeAndCleanAsync(string sessionDir, int fps, string ffmpegPath)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(sessionDir) || !Directory.Exists(sessionDir))
            {
                Console.WriteLine("No session directory to encode.");
                return;
            }

            // Must match the %06d.jpg input pattern
            bool any = Directory.EnumerateFiles(sessionDir, "*.jpg").Any();
            if (!any)
            {
                Console.WriteLine("No JPGs found. Skipping encoding.");
                return;
            }

            string outputMp4 = Path.Combine(
                Path.GetDirectoryName(sessionDir)!,
                Path.GetFileName(sessionDir) + ".mp4");

            Console.WriteLine("Post-processing: encoding JPGs ␦ MP4 ...");

            var psi = new ProcessStartInfo
            {
                FileName = ffmpegPath,
                Arguments = $"-y -framerate {fps} -i %06d.jpg -c:v libx264 -preset veryfast -pix_fmt yuv420p -movflags +faststart \"{outputMp4}\"",
                WorkingDirectory = sessionDir,
                UseShellExecute = false,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                CreateNoWindow = true
            };

            using var proc = new Process { StartInfo = psi };
            proc.Start();
            var stderrTask = proc.StandardError.ReadToEndAsync();
            var stdoutTask = proc.StandardOutput.ReadToEndAsync();
            await Task.WhenAll(proc.WaitForExitAsync(), stderrTask, stdoutTask);

            if (proc.ExitCode == 0 && File.Exists(outputMp4))
            {
                Console.WriteLine($"Saved: {outputMp4}");

                // Delete JPGs after success
                int deleted = 0;
                foreach (var f in Directory.EnumerateFiles(sessionDir, "*.jpg"))
                {
                    try { File.Delete(f); deleted++; } catch { /* ignore */ }
                }
                Console.WriteLine($"Deleted {deleted} JPGs.");
            }
            else
            {
                Console.WriteLine($"ffmpeg failed (exit {proc.ExitCode}). JPGs kept.");
                var err = await stderrTask;
                if (!string.IsNullOrWhiteSpace(err))
                    Console.WriteLine(err);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("Post-processing failed: " + ex.Message);
        }
    }
}
