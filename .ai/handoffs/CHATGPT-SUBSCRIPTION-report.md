# ChatGPT 订阅额度接入：总结与事故报告

日期：2026-11-23　分支：`feature/selection-actions-integrated`（均未提交）　当前安装包：`3.3.5-deefery.4`
设计细节见 [CHATGPT-SUBSCRIPTION-v1.md](../architecture/CHATGPT-SUBSCRIPTION-v1.md)。

## 1. 结论

- TransKit 已能用 ChatGPT 订阅额度做翻译（`chatgpt`）和 AI 动作（`chatgpt_ai`），无需 API Key。
- 第一次真实登录失败，**根因是你的扩展 `refreshing-personal`，不是 TransKit 的登录代码**。
- TransKit 已改用不同端口绕开。扩展那边是个潜在隐患，建议修（issue 草稿已写好）。
- **尚未验证**：换端口后的完整登录、取模型列表、真实翻译、令牌过期后刷新。需要你装 `deefery.4` 试一次。

## 2. 事故经过

| 时间（UTC） | 现象 |
|---|---|
| 08:01:20 | 点登录。TransKit 监听 `127.0.0.1:8787`，浏览器打开授权页。 |
| 之后 96 秒 | 日志里一次回调请求都没有。你看到跳到一个打不开的链接，页面写“登录没有完成”。 |
| 08:02:56 | 你再次点登录。旧登录被取消、新登录接手（这是我顺手修好的另一个问题）。 |
| 08:12:34 | 又一次，监听 5 分钟无请求，超时。 |
| — | 你发现跳转地址是 `chrome-extension://hlojhinadcblmehimlkeemldmknppogg/scripts/personal/chatgpt-callback.html`。 |

## 3. 根因

`refreshing-personal` 自己也实现了一套“使用 ChatGPT 登录”，回调地址和 DevKit 示例一样，都是
`http://127.0.0.1:8787/auth/callback`。它在 `scripts/personal/chatgpt-auth.js` 末尾注册了常驻的
`chrome.tabs.onUpdated` 监听：任何标签页跳到这个地址，都会被改写成它自己的回调页，**不检查是不是它发起的登录**。
没有待处理登录时，它报 `api_chatgpt_no_pending`，页面显示“登录没有完成”。
TransKit 的监听器因此永远等不到请求。

为什么只有你遇到：这个扩展装在你的 Chrome 和 Edge 里；两边共用了同一个端口号 8787。

## 4. 已做的处理

**TransKit 这边（已完成）**
- 回调端口由 8787 改为 **18787**。我确认授权端点对其他回环端口和路径都接受（authorize 阶段返回 302）。
- 等待登录的提示里加了一句：页面没回到 TransKit 时，可能是浏览器扩展拦截了 127.0.0.1 回调。
- 登录各阶段现在会写日志（`[chatgpt]` 开头，不含令牌），路径：`%APPDATA%\com.transkit.desktop\logs\TransKit.log`。
- 新登录会取代还在等待的旧登录，不再报“已有登录在进行”。
- 新增真实 socket 的回环测试：监听、错误请求不消耗登录、取消。Rust 共 29 项测试通过。

**扩展那边（待你决定）**
- issue 草稿：[refreshing-personal-issue-draft.md](refreshing-personal-issue-draft.md)。
- 我无法代为提交：本机 `gh` 登录的是 `SteveElrey`，看不到 `deefery/refreshing-personal`。我没有切换账号或改那个仓库。
- 建议修法：只在“存在未过期的待处理登录、且 URL 的 `state` 与之相同”时才改写；DNR 规则在回调处理、取消、超时时都要移除。

## 5. 对以后的影响

1. **端口占用登记**：TransKit 已用 60828（本地服务）、54321（云登录）、18787（ChatGPT）。两个项目都接 ChatGPT，应避免再选同一个端口。
2. **换端口的风险**：我只验证了 authorize 阶段接受 18787，没验证同意/动态注册阶段。如果仍失败，网页会有明确提示，把它发我即可。
3. **两个应用各自注册为独立应用**：在 ChatGPT 设置里会看到 TransKit 和 “Refreshing (personal build)” 两条授权，按协议应各自独立、互不影响（我没有在 ChatGPT 设置里实际核对）。
4. **令牌存储**：Windows 用 DPAPI；macOS/Linux 目前只是 0600 文件，没有系统加密。
5. **许可证**：OpenAI DevKit 是非商用许可，TransKit 是 GPL-3.0。我是按公开协议自行实现，没搬代码或素材；若以后要对外分发，建议再确认。
6. **默认模型**：留空会取 ChatGPT 列表第一项，可能偏重，翻译建议手选轻量模型。

## 6. 仍未解释的小疑点

08:02:56 那次新登录，我在 08:04 查看时 8787 上没有监听，而按理它还应在等待。当时没有对应日志。
之后 08:12:34 那次监听正常并如期超时，所以暂不构成阻碍；如果下次重现，日志现在能看出原因。

## 7. 下一步

1. 退出托盘里的 TransKit，安装 `src-tauri/target/release/bundle/nsis/TransKit_3.3.5-deefery.4_x64-setup.exe`。
2. 设置里添加“ChatGPT 订阅”，点“使用 ChatGPT 登录”。如果仍失败，把网页提示和日志里 `[chatgpt]` 的行发我。
3. 决定是否去扩展仓库提 issue（草稿已备好），以及是否让我准备一个 PR 补丁。
4. 通过后再提交这批改动（目前全部未提交）。
