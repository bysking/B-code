# 发布手册

> 这份文档记录**当前的发布机制**和**为什么这么设计**。
> 大部分规则背后都对应一次真实的踩坑或上游限制，改流程前先看「为什么」。

发布对象是 5 个 npm 包：


| 包                             | 内容                                          | registry 状态           |
| -------------------------------- | ----------------------------------------------- | ------------------------- |
| `@bysking/b-code`              | `bin/bcode.js` 启动器 + `lib/index.js`，~30KB | 已存在（2.x 为 ink 版） |
| `@bysking/b-code-darwin-arm64` | macOS Apple Silicon 二进制，~75MB             | **3.0.0 前不存在**      |
| `@bysking/b-code-darwin-x64`   | macOS Intel 二进制                            | **3.0.0 前不存在**      |
| `@bysking/b-code-linux-x64`    | Linux glibc 二进制                            | **3.0.0 前不存在**      |
| `@bysking/b-code-win32-x64`    | Windows 二进制                                | **3.0.0 前不存在**      |

为什么拆成 5 个包：二进制 ~75MB/平台，塞进一个包会让用户下 300MB。拆开后 npm 用
`os`/`cpu` 字段只装匹配的那一份。

---

## 一、日常发版（已配置好 Trusted Publishing 之后）

```bash
# ① 改版本号——两处都要改，漏一处用户就装不上
#    package.json 的 version
#    package.json 的 optionalDependencies 里 4 行平台包版本
#    （scripts/check-version.js 会拦，但知道为什么要改比被拦下更好）

# ② CHANGELOG.md：把 [Unreleased] 内容移到新版本小节并标日期

# ③ 提交后打 tag
git tag v3.0.1 && git push origin v3.0.1
```

CI（`.github/workflows/release.yml`）随后自动跑：

```
test ──────┐
           ├──→ build（4 平台矩阵，原生编译）──→ publish-platforms ──→ publish-main
check-version ─┘
```

顺序不能反：主包的 `optionalDependencies` 指向平台包，**主包先上线会让用户安装时解析不到平台包**。

也可以手动触发（Actions → Release → Run workflow，选 `main` 分支）：

- 勾 `dry_run` 只跑构建与校验，不执行 `npm publish`——改完 workflow 后建议先这样演练一次
- 手动触发时 `GITHUB_REF_NAME` 是分支名而不是 tag，所以 tag 与版本号的一致性校验会自动跳过

---

## 二、认证：Trusted Publishing (OIDC)

用 OIDC 而不是长期 token：job 声明 `permissions: id-token: write`，npm CLI 自动换取
短时发布令牌，并生成 provenance。没有可以泄露到日志里、需要定期轮换的写权限 token。

### 三个必须满足的前提


| 要求                                    | 为什么                                                                                                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **npm CLI ≥ 11.5.1**                   | 低于这个版本 npm 不认识 OIDC 环境，会静默回退到 token 认证。CI 用 **Node 24**（自带 npm 11.19.x）；**Node 22 只带 10.9.x，不够**。workflow 里有一步硬校验，版本不够直接报错                       |
| **5 个包各配一次**                      | Trusted Publisher 是**按包**配置的，不是按 scope。主包和 4 个平台包要分别进 Settings → Trusted Publisher 填一遍                                                                                  |
| **不给 `setup-node` 传 `registry-url`** | 它会往 `.npmrc` 写一个占位 token。OIDC 交换一旦失败，npm 会回退到这个假 token，报出 E404/ENEEDAUTH——**与真实原因完全无关**，极难排查（npm/cli#9969 就是这类）。workflow 改为自建干净的 `.npmrc` |

### npmjs.com 上的配置

每个包 → Settings → Trusted Publisher → GitHub Actions：

```
Organization or user: bysking
Repository:           B-code
Workflow filename:    release.yml
```

两个坑：

1. **Workflow filename 只填文件名**，不含路径、不能写成 `.github/workflows/release.yml`，但**必须带 `.yml` 后缀**。
2. 新配置**必须在 2 天内完成首次成功发布**，否则配置过期，只能删掉重建。

### 首次发布是例外——必须用 token

npm 目前**不支持用 OIDC 发布一个尚不存在的包**
（[npm/cli#8544#8544](https://github.com/npm/cli/issues/8544)，仍 open；PyPI 支持，npm 不支持）。

4 个平台包在 3.0.0 之前从未发布过（registry 全是 404），所以**首次发版必须有 token**。

workflow 因此同时支持两条路，按 secret 是否存在自动选择：


| 配置                    | 行为                                                     |
| ------------------------- | ---------------------------------------------------------- |
| 配了 `NPM_TOKEN` secret | 写入 `.npmrc`，用它发布。OIDC 仍会优先尝试，token 是回退 |
| 没配 `NPM_TOKEN` secret | 纯 OIDC                                                  |

**过渡步骤：**

1. 首次发版前，仓库 Settings → Secrets 配好 `NPM_TOKEN`（classic token，勾 `read and write` + 对 `@bysking` scope 的发布权限）
2. 打 tag，确认 4 个平台包都发出去、主包最后上线
3. 5 个包都进 npmjs.com 配好 Trusted Publisher
4. **删掉 `NPM_TOKEN` secret**——之后自动走纯 OIDC
5. 下一版验证一次，确认日志里有 `🔐 未配置 NPM_TOKEN，将使用 Trusted Publishing (OIDC)`

---

## 三、为什么必须各平台原生编译

`bun build --compile` 会把 OpenTUI 的原生包内联进产物。而 OpenTUI 用的是动态
`import('@opentui/core-<platform>')`，打包器据此把**所有平台**的原生包都视为必需依赖；
这些包带 `os`/`cpu` 字段，npm 只允许安装匹配当前机器的。

结果：**交叉编译必然因缺包失败**，只能每个平台在自己的 runner 上编译。这也是
CI 矩阵存在的唯一理由。

### runner 标签（会过期，注意）


| 平台         | 标签             | 注记                                  |
| -------------- | ------------------ | --------------------------------------- |
| darwin-arm64 | `macos-15`       |                                       |
| darwin-x64   | `macos-15-intel` | Intel；**不是** `macos-13`/`macos-14` |
| linux-x64    | `ubuntu-latest`  |                                       |
| win32-x64    | `windows-latest` |                                       |

`macos-13` 早已移除，`macos-14` 的全部镜像于 **2026-11-02 退役**
（actions/runner-images#15226）。若某天 job 卡在排队不动，先查标签是否又过期了。

---

## 四、本机手动发布（应急用）

本机只能发**当前平台**那一个包（原生编译的限制），其余要靠 CI。

```bash
bun install
node build-bun.js                 # → dist/bcode（~75MB，内含 Bun 运行时）
node scripts/pack-platform.js     # → dist-pkg/darwin-arm64/{bcode, package.json}
(cd dist-pkg/darwin-arm64 && npm publish --access public)
npm publish --access public       # 主包，必须在平台包之后
```

前提：本机已 `npm login`（`.npmrc` 已被 gitignore，token 不会入库）。

---

## 五、发布前自检清单

```bash
bun run typecheck        # 类型检查
bun test                 # 单元测试（必须用 Bun：OpenTUI 原生 FFI 只支持 Bun）
bun run check:version    # 版本号 + 平台清单一致性
node build-bun.js --all-check
```

`check:version` 校验的是：

- `optionalDependencies` 里 4 行平台包版本 == 主包 `version`
- 平台清单在 `optionalDependencies` / `bin/bcode.js` / `lib/index.js` /
  `scripts/pack-platform.js` **四处**一致
- `files` 覆盖 `main` 与 `bin` 所在目录
- （CI 传入时）git tag 与 `package.json` 版本一致

第一条最要紧：npm 对 `optionalDependencies` 的解析失败是**静默**的。版本号漂移的症状是
用户「装成功了但 `bcode` 跑不起来」——不会在安装时报错。

它已挂在 `prepublishOnly` 和 CI 的 `check-version` job 上，`npm publish` 时自动跑。

---

## 六、排错


| 症状                                                            | 原因                                                  | 处理                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| `E404` / `ENEEDAUTH`，但 token 明明是对的                       | 该包尚未存在，或 Trusted Publisher 没配到**这个**包上 | 首次发布用 token；其余检查 5 个包是否都配了           |
| 日志里 `Failed token exchange ... package not found`            | 同上，OIDC 发不了不存在的包                           | 用 token 发首次版本                                   |
| OIDC 悄悄失效、回退成 token                                     | npm < 11.5.1，或给 `setup-node` 传了 `registry-url`   | 用 Node 24；去掉 `registry-url`                       |
| `403 You cannot publish over the previously published versions` | 版本号没改就重跑                                      | workflow 已加幂等跳过，若仍报错说明该版本已被别人占用 |
| job 一直排队不动                                                | runner 标签已退役                                     | 见「runner 标签」一节                                 |
| `Could not resolve: @opentui/core-<platform>`                   | 该平台的原生包没装上                                  | 在目标平台 `bun install`，不要交叉编译                |
| 用户装完 `bcode` 报「缺少平台包」                               | 发布顺序反了，或版本号漂移                            | 确认平台包先于主包发布，并跑 `check:version`          |

---

## 七、文件职责


| 文件                            | 职责                                                                |
| --------------------------------- | --------------------------------------------------------------------- |
| `.github/workflows/release.yml` | 全部 CI 编排：测试 → 矩阵构建 → 发布平台包 → 发布主包            |
| `build-bun.js`                  | 当前平台编译成单文件可执行程序                                      |
| `scripts/pack-platform.js`      | 把产物打成可发布的平台 npm 包（写 `os`/`cpu`/`libc`）               |
| `scripts/check-version.js`      | 发布前一致性校验，防版本漂移与清单错配                              |
| `bin/bcode.js`                  | 主包启动器：定位平台包里的二进制并转发参数/信号/退出码              |
| `lib/index.js`                  | 主包库入口，让 `import('@bysking/b-code')` 拿到版本信息而不启动 TUI |
