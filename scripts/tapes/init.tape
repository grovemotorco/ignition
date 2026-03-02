Output docs/public/media/cli-init.gif

Source scripts/media/cli-tapes/ignition.tape

Set FontSize 16
Set FontFamily "Geist Mono"
Set Width 2400
Set Height 1200
# Set Padding 40

Type "cd /tmp && mkdir -p my-infra && cd my-infra"
Sleep 300ms
Enter
Sleep 1s

Type "ignition init"
Sleep 500ms
Enter
Sleep 4s

Type "ls -la"
Sleep 300ms
Enter
Sleep 2s
