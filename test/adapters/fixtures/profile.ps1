# PowerShell profile — hand edited, please don't nuke my comments.
Set-PSReadLineOption -PredictionSource History

function Set-PoshContext {
    # my own context setup, unrelated to chameleon
    $env:MY_CUSTOM_VAR = "hello"
}

oh-my-posh init pwsh --config "$env:POSH_THEME" | Invoke-Expression
