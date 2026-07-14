# 基智盘 v2.2

适配 EdgeOne Makers 的基金行情项目，顶部采用三个按钮式选项卡：

- `/realtime.html`：查看盘中估算行情。
- `/history.html`：读取正式历史净值，计算买入分、卖出分及六档操作建议。
- `/settings.html`：统一添加基金代码，并维护个人持仓。
- `/`：自动进入实时行情页。

## 设置页保存的数据

- 最多 12 只基金代码
- 已识别的基金名称
- 成本净值
- 投入本金
- 计划最高金额

实时行情页和历史分析页只读取设置页保存的基金列表；历史分析会自动使用个人持仓计算超配程度、持仓收益和卖出分。

## 数据加载

浏览器首先通过 JSONP 读取公开基金数据；当 JSONP 不可用时，调用 EdgeOne Functions：

- `/api/realtime/005827`
- `/api/history/005827`
- `/api/health`

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

KV 会同步基金代码、基金名称、风险档位、刷新频率、止盈目标和个人持仓。

## 更新 GitHub

将本项目内容覆盖到原仓库根目录后提交：

```bash
git add .
git commit -m "增加基金与个人持仓设置页"
git push origin main
```
