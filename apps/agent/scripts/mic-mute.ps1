<#
  HomePanel example action "mute-mic": toggle mute on the default microphone.

  Works out of the box: it talks to Windows Core Audio directly (no module to install) and mutes
  BOTH the default and the default *communications* microphone, so Discord/Teams/games all go
  quiet. Prints "muted" or "unmuted".

  Options:
    mic-mute.ps1            toggle
    mic-mute.ps1 -Mute      always mute
    mic-mute.ps1 -Unmute    always unmute

  Alternative with the AudioDeviceCmdlets module (see audio-switch.ps1 for installing it):
    Set-AudioDevice -RecordingMuteToggle

  Alternative without a script: give Discord a "Toggle Mute" keybind and use a keys action:
    mute-mic: { type: keys, keys: ctrl+shift+m }

  Windows PowerShell 5.1 compatible.
#>
param([switch]$Mute, [switch]$Unmute)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace HomePanelAudio {
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
      if (hr != 0 || device == null) return null;
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object o;
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o));
      return (IAudioEndpointVolume)o;
    }

    // mode: 0 = toggle, 1 = mute, 2 = unmute
    public static string Set(int mode) {
      var main = Endpoint(eConsole);
      if (main == null) throw new InvalidOperationException("No default microphone found.");
      bool muted;
      Marshal.ThrowExceptionForHR(main.GetMute(out muted));
      bool target = mode == 1 ? true : mode == 2 ? false : !muted;
      Guid ctx = Guid.Empty;
      Marshal.ThrowExceptionForHR(main.SetMute(target, ref ctx));
      var comms = Endpoint(eCommunications);
      if (comms != null) comms.SetMute(target, ref ctx);
      return target ? "muted" : "unmuted";
    }
  }
}
'@

$mode = 0
if ($Mute) { $mode = 1 } elseif ($Unmute) { $mode = 2 }
[HomePanelAudio.Mic]::Set($mode)
