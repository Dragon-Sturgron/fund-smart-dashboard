# 基智盘 v2.1

适配 EdgeOne Makers 的基金行情项目，已拆成两个独立页面：

- `/realtime.html`：查看盘中估算行情，支持自动刷新。
- `/history.html`：读取正式历史净值，计算买入分、卖出分及六档操作建议。
- `/`：基金列表管理和页面入口。

## 为什么本版能绕开 Failed to fetch

浏览器首先通过 JSONP 读取公开基金数据，不受普通 CORS 限制；当 JSONP 不可用时，才调用 EdgeOne Functions：

- `/api/realtime/005827`
- `/api/history/005827`
- `/api/health`

因此即使某个 EdgeOne 上游代理暂时失败，也不会立刻导致所有基金显示 `Failed to fetch`。

## EdgeOne Makers 构建配置

- 框架预设：Other
- 根目录：`./`
- 构建命令：`npm run check`
- 输出目录：`public`
- 安装命令：留空

## KV

创建 KV 命名空间后，在项目中绑定变量名：

```text
FUND_KV
```

KV 会保存基金代码、基金名称、风险档位、刷新频率、止盈目标和持仓信息。

## 更新 GitHub

将本项目内容覆盖到原仓库根目录，删除旧的 `edge-functions/api/fund` 文件夹，然后提交：

```bash
git add .
git commit -m "拆分实时行情和历史分析页面并修复数据加载"
git push origin main
```


## v2.1 页面切换

- 顶部改为两个按钮式选项卡：`实时行情页` 与 `历史分析页`。
- 当前页面选项卡高亮，电脑端和手机端均可一键来回切换。
- 访问根域名 `/` 时自动进入实时行情页。
