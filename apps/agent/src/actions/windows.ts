/**
 * Inline PowerShell snippets for Windows actions. They are constants (no interpolation of
 * anything from MQTT or config except fixed enum values) and are sent with -EncodedCommand.
 */
import type { MediaKey } from "../config.js";

export const VK: Record<MediaKey, number> = {
  media_play_pause: 0xb3,
  media_next: 0xb0,
  media_prev: 0xb1,
  volume_up: 0xaf,
  volume_down: 0xae,
  volume_mute: 0xad,
};

/** Press + release one virtual key with keybd_event (works for media keys without focus). */
export function keyPressScript(key: MediaKey): string {
  const vk = VK[key];
  return `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace HomePanel -Name Keys -MemberDefinition @'
[DllImport("user32.dll")]
public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@
# KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2
[HomePanel.Keys]::keybd_event(${vk}, 0, 1, [UIntPtr]::Zero)
[HomePanel.Keys]::keybd_event(${vk}, 0, 3, [UIntPtr]::Zero)
`.trim();
}

/**
 * Turn monitors off: WM_SYSCOMMAND / SC_MONITORPOWER / 2 broadcast to all top-level windows.
 * PostMessage instead of SendMessage: a broadcast SendMessage blocks until *every* window
 * answers and can hang on a frozen app; the effect is the same.
 */
export const MONITORS_OFF_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace HomePanel -Name Monitor -MemberDefinition @'
[DllImport("user32.dll")]
public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
'@
# HWND_BROADCAST = 0xFFFF, WM_SYSCOMMAND = 0x0112, SC_MONITORPOWER = 0xF170, 2 = off
[void][HomePanel.Monitor]::PostMessage([IntPtr]0xFFFF, 0x0112, [IntPtr]0xF170, [IntPtr]2)
`.trim();

/**
 * Toggle mute on the default recording device via Core Audio (IMMDeviceEnumerator →
 * IMMDevice → IAudioEndpointVolume). No modules needed. The new state is applied to both the
 * "console" and the "communications" default microphones (Discord/Teams use the latter) so
 * they never end up out of sync. Prints "muted" or "unmuted".
 */
export const MUTE_MIC_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace HomePanel {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
  interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr pNotify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr pNotify);
    [PreserveSig] int GetChannelCount(out uint pnChannelCount);
    [PreserveSig] int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
    [PreserveSig] int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
    [PreserveSig] int GetMasterVolumeLevel(out float pfLevelDB);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float pfLevel);
    [PreserveSig] int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
    [PreserveSig] int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
  }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorComObject { }

  public static class Mic {
    const int eCapture = 1, eConsole = 0, eCommunications = 2, CLSCTX_ALL = 23;

    static IAudioEndpointVolume Endpoint(int role) {
      var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IMMDevice device;
      int hr = enumerator.GetDefaultAudioEndpoint(eCapture, role, out device);
      if (hr != 0 || device == null) return null; // no microphone for this role
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object o;
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o));
      return (IAudioEndpointVolume)o;
    }

    public static string Toggle() {
      var console = Endpoint(eConsole);
      if (console == null) throw new InvalidOperationException("no default microphone");
      bool muted;
      Marshal.ThrowExceptionForHR(console.GetMute(out muted));
      bool target = !muted;
      Guid ctx = Guid.Empty;
      Marshal.ThrowExceptionForHR(console.SetMute(target, ref ctx));
      var comms = Endpoint(eCommunications);
      if (comms != null) comms.SetMute(target, ref ctx);
      return target ? "muted" : "unmuted";
    }
  }
}
'@
[HomePanel.Mic]::Toggle()
`.trim();
