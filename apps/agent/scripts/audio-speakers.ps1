<#
  HomePanel example action "audio-speakers": make the speakers the default output.
  Edit the -Name below to match your device (see audio-switch.ps1 for how to list names).
  Needs the AudioDeviceCmdlets module:  Install-Module AudioDeviceCmdlets -Scope AllUsers -Force
#>
& "$PSScriptRoot\audio-switch.ps1" -Name "Speakers"
exit $LASTEXITCODE
