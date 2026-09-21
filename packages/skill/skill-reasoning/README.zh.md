---
description: "随包附带的推理纪律 skill——程序优先计算、分解优先规划、best-of-n 采样、树搜索与协作辩论——供启用或调优它们的用户阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-reasoning

[English](README.md) | 中文

## 概述

该内置提供方随包分发六个推理纪律 skill。`program-first` 把数值与数据变换类工作路由到「写程序并执行」；`decompose-first` 把多约束任务拆成有序子问题串行求解；`best-of-n-sampling` 与 `tree-search` 教完整的 `workflow` 工具模式——并行候选加可执行检查/投票/裁判选择，以及评分驱动的迭代改进。提供方在 `dsh` base 组合中默认启用，所有 base 系 profile 随包携带这些纪律。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

启用插件即可把四个 skill 加入会话 skill 目录；模型按需加载，方式与其他 skill 相同。

### 何时选择

当会话承担高风险的数值、分析或采样工作，且部署方希望这些纪律无需在本地撰写 skill 即可用时，选择此提供方。当会话只是简短对话类任务时请跳过——这些 skill 在被使用前只消耗目录行，而两个采样 skill 一旦被调用会成倍增加模型调用。

### 启用插件

```yaml
- name: '@deepseek-ai/dsh-skill-reasoning'
```

随附 base 组合以 `disabled: true` 携带该行；在那里需要通过 overlay 行（`$DSH_HOME/cordis.patch.yml` 或 `--patch <file>`）显式启用。`assetRoot` 供打包应用重定位资源时使用。

### 这些 skill 提供什么

- **`program-first`** —— 不报告未执行的算术：写程序、运行、报告打印值。一个 skill 一个习惯；按 token 计，这是此处所有纪律中可靠性收益最高的一个。
- **`decompose-first`** —— 面向多跳与多约束任务的有序、可检验子问题，步骤之间核验前提，最后对照全部原始约束复核。
- **`best-of-n-sampling`** —— 可直接照抄的 `workflow` 脚本：并行生成候选，三级选择（可执行检查、多数投票、独立裁判），附成本指引。
- **`tree-search`** —— 可照抄的迭代改进脚本：保留当前最佳候选、并行改进、同一裁判评分、严格晋级与无增益提前停止。
- **`collaborative-debate`** —— 可照抄的双辩手脚本：跨模型路由、对源文本逐字核验的引文证据、保留分歧的裁判；针对辩论的两种已证实失败模式（竞技修辞与共识回声）设计。
- **`reasoning-router`** —— 分诊与升级纪律：先判定任务的错误类型，再沿最省钱的策略阶梯（直答→自查→执行/核验→多样化→对辩）只升到失败证据所需的层级。

### 可观察的成功与失败

插件挂载后，六个 skill 出现在会话目录中并可凭名称加载（也可用 `/skill-name`）；禁用该行则它们不出现在任何目录中。资源树损坏——缺失 `SKILL.md`、或缺少 frontmatter/描述——会让插件加载大声失败，而不是注册出残缺目录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释内置提供方的接线方式；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计概念

提供方是不可变的 skill 源：加载时解析每个随包 `assets/<name>/SKILL.md` 的 frontmatter（缺文件、缺 frontmatter、缺描述都会在加载时大声失败），以内置 skill 秩（600）、提供方名 `dsh-reasoning` 注册四个候选，并在每次加载时从随包文件读取正文。采样类 skill 携带完整的 `workflow` 脚本而非工具代码：`workflow` 工具本就接受任意脚本，模型可逐字照抄的脚本不需要新的包面或 loop 改动。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：frontmatter 解析与不可变的四候选提供方 |
| — | 未发布运行时不变量伴随件；本包只持有一个不可变的提供方注册，注册唯一性与生命周期检查由 skill 注册表持有。 |
| [`assets/`](assets/) | 随包 skill 正文（`<name>/SKILL.md`），每个 skill 一个目录 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时阅读这些页面。它们从提供方注册的注册表讲到采样如何到达模型。

- [Skill 子系统参考](../../../docs/subsystems/skills.zh.md) —— 本提供方实现的注册表与提供方契约。
- [tool-skill 包](../tool-skill/README.zh.md) —— 这些 skill 如何进入会话目录并到达模型。
- [Workflow 子系统参考](../../../docs/subsystems/workflow.zh.md) —— 两个采样 skill 所编程的引擎与脚本契约。

-----

<a id="model-experience"></a>
## 模型体验

间接经由 `dsh-tool-skill`，由它把提供方的目录条目与被选中的 skill 正文渲染给模型。

#### KV 缓存影响

五条目录条目随持久的 skills 提醒消息下发；任何被加载的正文以保留的工具结果内容跟进。两者都追加在可复用请求前缀之后，不会使既有 KV 缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义该内置提供方不做什么。它们是当前包约束，不是任务 backlog。

- **采样 skill 教模式，不教策略** —— `workflow` 工具自身的提示区把 workflow 限制为用户显式请求；这些 skill 继承该策略，无法放宽。
- **裁判多样性来自提示** —— 采样脚本通过措辞与指令制造候选多样性；按子代理设置采样参数（temperature、seed）未暴露给 workflow 脚本。
- **六个固定 skill** —— 需要其他纪律的部署方应自行撰写 skill，而不是扩展本提供方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
