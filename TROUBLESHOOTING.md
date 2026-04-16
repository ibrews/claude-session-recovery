# Troubleshooting — Claude Desktop Recovery

This tool fixes one specific class of problem: **sessions missing from the Claude Desktop UI**. If that's you, skip to [Scenario A](#scenario-a--sessions-missing-from-the-desktop-ui).

If your problem is that **Claude Desktop won't install or update**, that's a different layer (Windows MSIX packaging) and this tool can't help directly — but the recipe is in [Scenario B](#scenario-b--windows-install-fails-with-0x80073cf6-or-0x80073d05) below because the two situations frequently get confused.

## Decision tree

```
Is Claude Desktop INSTALLED and LAUNCHES?
├─ No  → Scenario B (install-layer failure)
└─ Yes → Do past sessions appear in the UI?
         ├─ No  → Scenario A (use this tool's `restore`)
         └─ Yes → Not a scenario this doc covers
```

---

## Scenario A — Sessions missing from the Desktop UI

**Cause:** Claude Desktop's session *index* at
`%APPDATA%\Claude\claude-code-sessions\<org-uuid>\<user-uuid>\local_<uuid>.json`
(`~/Library/Application Support/Claude/...` on macOS) got corrupted or wiped.

The conversation data itself lives separately at `~/.claude/projects/<project>/<session-id>.jsonl` and is almost always intact — even after BSODs, hard shutdowns, disk errors, or a Claude Desktop reinstall.

**Fix:**

```bash
python recover.py list               # confirm the sessions exist on disk
python recover.py restore --dry-run  # preview what will be rebuilt
python recover.py restore            # rebuild missing index entries
# Restart Claude Desktop
```

See the main [README](./README.md) for details, filtering, and the MCP server.

---

## Scenario B — Windows install fails with `0x80073CF6` or `0x80073D05`

**Cause:** the MSIX package state in Windows' AppX repository is corrupt — usually because a previous uninstall/update left orphaned package entries that Windows can't clean up, and/or a background process (AV, Search indexer) is holding file handles on the package's virtual registry hive (`Helium\User.dat`).

Symptoms in `%TEMP%\ClaudeSetup.log`:

```
MSIX installation failed: AddPackage failed with HRESULT 0x80073CF6
```

And, via `Get-AppPackageLog -ActivityID <id>`, inner errors like:

```
error 0x80073D05: ... An error occurred while deleting the package's previously existing application data.
Error while deleting file ...\Helium\User.dat. Error Code : 0x20   (sharing violation)
```

### Recipe (Windows 10/11, elevated PowerShell)

**Step 1 — Force-remove ghost packages:**

```powershell
# List any leftover Claude packages across all users
Get-AppxPackage -AllUsers -Name 'Claude*'

# Force-remove each one (replace PackageFullName as listed above)
Get-AppxPackage -AllUsers -Name 'Claude*' |
    ForEach-Object { Remove-AppxPackage -Package $_.PackageFullName -AllUsers -ErrorAction SilentlyContinue }
```

**Step 2 — Check for leaked virtual-HKCU hives:**

```powershell
# Any Claude hive still mounted under HKEY_USERS?
(reg query HKU 2>$null) -split "`n" | Where-Object { $_ -match 'Claude_pzs8sxrjxfjjc|Helium.*Claude' }
# If any returned, unload:
#   reg unload "HKU\<the-key-name>"
```

**Step 3 — Clean both MSIX data roots (take ownership first):**

```powershell
foreach ($p in @("$env:LOCALAPPDATA\Packages\Claude_pzs8sxrjxfjjc",
                  "C:\ProgramData\Packages\Claude_pzs8sxrjxfjjc")) {
    if (Test-Path $p) {
        takeown /F $p /R /D Y | Out-Null
        icacls  $p /grant 'Administrators:F' /T /C /Q | Out-Null
        Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue
    }
}
```

**Step 4 — If any file is locked, schedule delete-on-reboot and reboot:**

```powershell
Add-Type -Namespace Win32 -Name File -MemberDefinition @'
[DllImport("kernel32.dll", CharSet=CharSet.Auto, SetLastError=true)]
public static extern bool MoveFileEx(string lpExistingFileName, string lpNewFileName, int dwFlags);
'@
Get-ChildItem "$env:LOCALAPPDATA\Packages\Claude_pzs8sxrjxfjjc","C:\ProgramData\Packages\Claude_pzs8sxrjxfjjc" `
    -Recurse -Force -ErrorAction SilentlyContinue |
    Sort-Object @{Expression={$_.FullName.Length}; Descending=$true} |
    ForEach-Object { [Win32.File]::MoveFileEx($_.FullName, $null, 4) | Out-Null }
# Reboot, then re-run `Claude Setup.exe`.
```

**Step 5 — Re-run the installer:**

After the data roots are gone (or have been cleared on reboot), run `Claude Setup.exe` normally. The MSIX install's "delete previous app data" step will no longer trip on sharing violations.

### ...then Scenario A almost always follows

A fresh MSIX install wipes `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\` — which is where the session index lives. Your raw conversation data at `~/.claude/projects/` is outside the MSIX sandbox and survives. Once Claude Desktop launches on the fresh install, most past sessions will appear missing from the UI:

```bash
python recover.py restore
# Restart Claude Desktop — sessions reappear.
```

---

## Diagnostic commands (both scenarios)

```powershell
# Is Claude registered?
Get-AppxPackage -Name 'Claude*' | Select-Object Name,Version,Status

# What errors did the last install hit?
Get-Content "$env:TEMP\ClaudeSetup.log" | Select-String -Pattern 'error|fail|0x' | Select-Object -Last 20

# Full AppX trace for a specific ActivityId from ClaudeSetup.log
Get-AppPackageLog -ActivityID <activity-id-from-log>

# All Claude-related AppX events today
Get-AppxLog -All | Where-Object { $_.TimeCreated -ge (Get-Date).Date -and $_.Message -match 'Claude' }
```
