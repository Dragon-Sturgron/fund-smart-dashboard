# 基金行情辅助决策台（EdgeOne Makers + KV）

静态前端 + Edge Functions，支持基金行情查询、规则化买卖信号、持仓录入，以及 EdgeOne KV 云端保存。

## 项目结构

```text
public/                         静态网页
edge-functions/api/fund/[code].js  基金行情代理接口
edge-functions/api/config.js       KV 配置读写接口
```

## EdgeOne Makers 构建配置

- 框架预设：Other
- 根目录：`./`
- 输出目录：`public`
- 构建命令：`npm run check`
- 安装命令：留空

## KV 配置（必须）

1. 在 EdgeOne Makers 顶部进入“KV 存储”，开通后创建命名空间，建议名称：`fund_dashboard`。
2. 进入当前项目，打开“KV 存储”。
3. 点击“绑定命名空间”。
4. 选择刚创建的命名空间。
5. **变量名必须填写：`FUND_KV`**。
6. 完成绑定后，重新部署一次生产环境。

网页会自动保存：基金代码、风险档位、刷新频率、止盈目标、成本净值、投入本金及计划最高金额。

KV 使用固定记录键：`fund_dashboard_state_v2`。首次打开时：

- KV 有数据：优先从 KV 恢复；
- KV 为空、本机有旧数据：自动迁移到 KV；
- KV 未绑定或暂时不可用：继续使用浏览器本地缓存。

> EdgeOne KV 是最终一致性存储，其他边缘节点读取到新值最长可能有约 60 秒延迟。

## GitHub 更新

把本目录内容覆盖到 GitHub 仓库后执行：

```bash
git add .
git commit -m "增加 EdgeOne KV 云端存储"
git push origin main
```

EdgeOne Makers 会自动触发新部署。部署完成后再绑定 KV 或确认绑定仍然存在。

## 数据安全提示

当前版本是单用户共享配置：访问同一网站的所有人会读取和修改同一份 KV 数据。建议不要公开分享网站地址。需要公开使用时，应追加登录或访问密码。
