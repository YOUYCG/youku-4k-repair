# 补丁使用

需要 Windows 优酷客户端及 Node.js 18 或更高版本。脚本在本机运行，从缓存的播放页定位播放器，再匹配播放器的代码结构。版本号改变后，只要相应结构仍能唯一识别，就可以继续应用。

命令从技能目录执行。把下面的安装目录替换为本机包含 `YOUKU.exe` 的目录。

```powershell
node .\scripts\youku-patch.cjs check
node .\scripts\youku-patch.cjs status "C:\Apps\YOUKU\9.5.3.1001"
```

先播放一个影片以生成资源缓存，然后从托盘退出优酷。根据需要执行其中一项或两项。

```powershell
node .\scripts\youku-patch.cjs apply
node .\scripts\youku-patch.cjs protect "C:\Apps\YOUKU\9.5.3.1001"
```

`apply` 新增「智能 4K（固定）」。`protect` 改的是优酷主程序的后台整包更新、退出时自动安装和自动资源缓存清除。手动检查更新、手动清理各自仍可用。后续手动更新请重新验证版本兼容性。暂缓更新意味着客户端也暂时无法随官方自动获取修复。

各命令先匹配代码，再验证语法、备份和校验写入结果。定位失败或代码结构有歧义时，使用 Skill 定位变动后重新适配。SHA-256 用于识别本次修改和原始备份。备份位置为 `%LOCALAPPDATA%\youku-4k-repair\backups`。还原前先从托盘退出优酷。

```powershell
node .\scripts\youku-patch.cjs restore
node .\scripts\youku-patch.cjs unprotect "C:\Apps\YOUKU\9.5.3.1001"
```

`restore` 还原画质菜单资源，`unprotect` 恢复自动更新和自动清理的原逻辑。正常启动后验证。先按相应命令还原本机补丁，再从 Codex 的技能目录移除 `youku-4k-repair` 可卸载技能。
