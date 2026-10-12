<#
  HomePanel example action "audio-headphones": make the headphones/headset the default output.
  Edit the -Name below to match your device (see audio-switch.ps1 for how to list names).
  Needs the AudioDeviceCmdlets module:  Install-Module AudioDeviceCmdlets -Scope AllUsers -Force
#>
& "$PSScriptRoot\audio-switch.ps1" -Name "Headphones"
exit $LASTEXITCODE
