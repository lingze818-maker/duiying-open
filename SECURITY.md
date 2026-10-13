# SECURITY.md · 安全策略

## 支持版本

| 版本 | 支持状态 |
|---|---|
| 0.2.x | ✅ |

## 报告漏洞

请通过 GitHub [Security Advisories](https://github.com/lingze818-maker/duiying-open/security/advisories/new)
私密报告，不要开公开 issue。48 小时内确认，修复后致谢（除非你希望匿名）。

## 安全模型（设计边界）

- **引擎无网络行为**：检索纯本地文件，无遥测、无上传、无 API 调用。
- **MCP server 仅 stdio**：绑定标准输入输出，不监听任何端口；它继承宿主
  进程的文件权限，能读 `--root`/`DUIYING_ROOTS` 指向的目录。
- **无认证设计的前提是本地**：stdio 模式下无网络暴露面；请勿将 server
  改造为网络服务后暴露到不可信网络（如需远程记忆检索，请自行前置认证
  反向代理，并自行承担风险）。
- **frontmatter 状态是内容层约定**，不是安全边界——`suppress` 的语义是
  "检索不浮出"，不是加密或访问控制。真正的秘密不要写进任何被检索的文件。
