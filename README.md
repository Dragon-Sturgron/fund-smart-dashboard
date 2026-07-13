# 基金行情辅助决策台（EdgeOne Makers）

这是一个无需数据库、可直接部署到 EdgeOne Makers 的基金行情网页。页面结构参考“基金实时局势辅助报表”的信息层级，但使用了独立设计与代码。

## 功能

- 多基金代码查询（最多 12 只）
- 实时估算净值与历史净值
- 近 20/60/250 日表现、年线偏离、回撤、年化波动
- 自动计算买入分 B 和卖出分 S
- 六档操作：暂缓买入、持有并分批买、分批买入/定投、暂停加仓重新评估、分批减仓、分批卖出
- 保守/普通/激进三种风险档位
- 持仓成本、本金、计划上限与止盈目标
- 自动刷新、配置导入导出、移动端适配

## 目录

```text
public/                         静态网页
  index.html
  assets/styles.css
  assets/app.js
edge-functions/                EdgeOne Makers 边缘函数
  api/fund/[code].js            基金行情代理接口
package.json
README.md
```

## EdgeOne Makers 部署

1. 将整个项目上传到 GitHub、Gitee 或 Coding 仓库。
2. 进入 EdgeOne Makers，选择“导入 Git 仓库”。
3. 推荐部署参数：
   - Framework Preset：`None`
   - Root Directory：仓库根目录
   - Build Command：留空，或填写 `echo no build needed`
   - Output Directory：`public`
4. 不需要配置 KV、数据库或环境变量。
5. 部署后，`edge-functions/api/fund/[code].js` 会自动映射为 `/api/fund/六位基金代码`。

## 本地预览

静态页面可以运行：

```bash
npm run serve
```

由于本地静态服务器不会模拟 EdgeOne 边缘函数，基金查询接口需要在 EdgeOne Makers 部署后测试。也可以安装 EdgeOne CLI 后使用 Makers 的本地调试命令。

## 计算说明

- “位置百分位”使用近 252 个净值数据计算，不等同于 PE/PB 估值。
- 主动基金的持仓与基金经理变化无法仅靠净值自动识别，因此“暂停加仓并重新评估”仍需要人工核对公告。
- 场外基金盘中数据为第三方估算值，最终以基金公司披露的正式净值为准。
- 本项目只提供规则化辅助，不构成投资建议或收益承诺。
