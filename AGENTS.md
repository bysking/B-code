<!-- cos:rules:start -->
## 仓库认知索引（cos）

本项目维护一份认知索引，全部数据在 `.codebase_store/` 目录下：

```
.codebase_store/
├── cos.txt          Root：声明有哪些 Volume、项目定位、全局不变量
├── cos.meta.txt     Meta：标签字典、FRAS 规则、配额、创作约束
├── cos.code.txt     Code Volume：代码对象的 Entry（真正的内容在这里）
├── config.json      scope 规则、分块预算、刷新阈值
└── baseline.json    源码与 Entry 的指纹基线
```

**开工前先读索引，不要每次重新搜索整个代码库。**

### 强制规则

1. **读一次，用全程**：新会话开始先调用 `cos_overview` 读完整个索引（超预算时顺 `nextCursor` 读到最后一个 chunk）。之后同一会话不要机械重复读。
2. **语义只由你创作**：程序不会替你生成 F/R/A/S。禁止"先机器出草稿再润色"。
3. **S 字段两问准入**：每句话都要通过 ——（a）能否从对象名/标签/F/R/A 直接推断？能则不写；（b）删掉它会不会导致改错代码/数据/生命周期？不会则不写。
4. **改完代码必须维护索引**：代码与测试稳定后调用 `cos_maintain`，按返回的 `nextAction` 处理受影响 Entry。
5. **不要手改索引文件**：`.codebase_store/cos.code.txt` 只能通过 `cos_update` 写，程序会做配额、引用、回读校验。手改会被下次 CAS 冲突挡下。
6. **不要在包装脚本里复制状态机**：权威状态机在 `cos_maintain` 返回里。

### 项目

`B-code`

<!-- cos:rules:end -->
