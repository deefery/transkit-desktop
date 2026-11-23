# Issue draft for deefery/refreshing-personal

> I could not file this myself: the `gh` login on this machine is `SteveElrey`, which cannot see
> `deefery/refreshing-personal`. Paste the text below into a new issue (or tell me to use a different
> credential).

**Title:** ChatGPT sign-in callback listener hijacks other apps' `127.0.0.1:8787/auth/callback` redirects

## What happens

While the extension is installed (Chrome and Edge, same profile), signing in to ChatGPT from a *different*
local app that also uses `http://127.0.0.1:8787/auth/callback` (observed with TransKit Desktop 3.3.5-deefery.x)
never reaches that app. After consenting on auth.openai.com the tab is sent to
`chrome-extension://hlojhinadcblmehimlkeemldmknppogg/scripts/personal/chatgpt-callback.html?code=…&state=…`,
which shows **「登录没有完成」**, and the other app's loopback listener receives no request at all
(confirmed in its log: listener bound, no request, 5-minute timeout).

## Cause

`scripts/personal/chatgpt-auth.js` ends with an always-on fallback:

```js
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const url = changeInfo?.url;
    if (!url || !url.startsWith(自用版_ChatGPT回调)) return;
    ...
    chrome.tabs.update(tabId, { url: chrome.runtime.getURL(自用版_ChatGPT回调页) + search })
```

It rewrites **any** tab that navigates to `http://127.0.0.1:8787/auth/callback…`, whether or not the extension
started that sign-in. With no pending sign-in, `自用版_ChatGPT处理回调` fails with `api_chatgpt_no_pending`,
so the user sees the generic failure page. The session DNR rule installed by `自用版_ChatGPT装回调规则`
(same regex) has the same scope while an extension sign-in is in progress.

Port 8787 is also the example port in OpenAI's DevKit, so any app copying that example collides.

## Suggested fix

1. In the `tabs.onUpdated` fallback, read `personal_chatgpt_pending` from `chrome.storage.session` and only
   redirect when a pending sign-in exists, is not expired, and the URL's `state` parameter equals
   `pending.state` (and, ideally, `tabId` matches `pending.tabId`). Otherwise leave the navigation alone.
2. Make sure the DNR session rule is removed as soon as the callback is handled, cancelled or expired
   (not just on the success path), so it cannot outlive the sign-in.
3. Optional hardening: use a less common port and a path specific to the extension
   (e.g. `/refreshing/callback`). I checked that `auth.openai.com/api/accounts/authorize` accepts other
   loopback ports and paths at the authorize step; I did not verify the consent/registration step.

## Not an issue on the TransKit side

TransKit has moved its callback to port 18787, so the two no longer collide. This issue is about the
extension silently taking over redirects that are not its own.
