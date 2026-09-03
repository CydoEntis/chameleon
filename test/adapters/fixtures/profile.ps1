# PowerShell profile — hand edited, please don't nuke my comments.

Set-Alias ll Get-ChildItem

# I like a short history so tab-complete stays fast
Set-PSReadLineOption -MaximumHistoryCount 500

function Set-PoshContext {
    # tells oh-my-posh which kube context to show
    $env:KUBECONTEXT = (kubectl config current-context 2>$null)
}

function prompt {
    "PS $($executionContext.SessionState.Path.CurrentLocation)> "
}
