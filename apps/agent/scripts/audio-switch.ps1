<#
  HomePanel example actions "audio-speakers" / "audio-headphones": switch the default Windows
  playback device by (part of) its name.

  REQUIRES the AudioDeviceCmdlets PowerShell module. Install it once, in an *administrator*
  PowerShell (Windows PowerShell 5.1 is fine):

      Install-Module -Name AudioDeviceCmdlets -Scope AllUsers -Force
      # If asked to install the NuGet provider or trust PSGallery, answer Y.
      # -Scope AllUsers matters: the agent runs as you, but elevated, and must find the module.

  Find the exact names of your devices with:

      Get-AudioDevice -List | Where-Object Type -eq 'Playback' | Format-Table Index, Name

  Then put the right names in agent.yaml:

      audio-speakers:   { type: script, script: 'scripts\audio-switch.ps1', args: ['-Name', 'Speakers'] }
      audio-headphones: { type: script, script: 'scripts\audio-switch.ps1', args: ['-Name', 'Arctis'] }

  Usage:  audio-switch.ps1 -Name "Speakers"      (matches "Speakers (Realtek(R) Audio)")
          audio-switch.ps1 -Name "Headphones" -AlsoCommunications
#>
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [switch]$AlsoCommunications
)
$ErrorActionPreference = 'Stop'

if (-not (Get-Module -ListAvailable -Name AudioDeviceCmdlets)) {
  Write-Error "AudioDeviceCmdlets is not installed. Run in an admin PowerShell: Install-Module AudioDeviceCmdlets -Scope AllUsers -Force"
  exit 2
}
Import-Module AudioDeviceCmdlets

$match = Get-AudioDevice -List |
  Where-Object { $_.Type -eq 'Playback' -and $_.Name -like "*$Name*" } |
  Select-Object -First 1
if (-not $match) {
  $names = (Get-AudioDevice -List | Where-Object Type -eq 'Playback' | ForEach-Object Name) -join '; '
  Write-Error "No playback device matching '$Name'. Available: $names"
  exit 3
}

if ($AlsoCommunications) {
  Set-AudioDevice -ID $match.ID | Out-Null                       # default + communications
} else {
  Set-AudioDevice -ID $match.ID -DefaultOnly | Out-Null          # keep Discord/Teams device as is
}
Write-Output "Default playback device: $($match.Name)"
