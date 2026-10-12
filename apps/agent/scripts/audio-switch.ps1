<#
  HomePanel example: switch the default Windows playback device by (part of) its name.

  Requires the AudioDeviceCmdlets PowerShell module (one-time setup, in an *admin* PowerShell):

      Install-Module -Name AudioDeviceCmdlets -Scope AllUsers -Force
      # If asked about NuGet / an untrusted repository, answer Y.

  Find the exact names of your devices with:

      Get-AudioDevice -List | Where-Object Type -eq 'Playback' | Format-Table Index, Name

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
