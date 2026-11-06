# 发布手册

> 这份文档记录**当前的发布机制**和**为什么这么设计**。
> 大部分规则背后都对应一次真实的踩坑或上游限制，改流程前先看「为什么」。

发布对象是 5 个 npm 包：


| 包                             | 内容                                          | registry 状态                          |
| -------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| `@bysking/b-code`              | `bin/bcode.js` 启动器 + `lib/index.js`，~30KB | 已存在（latest 2.0.2，ink 版）         |
| `@bysking/b-code-darwin-arm64` | macOS Apple Silicon 二进制，~75MB             | 已存在（`1.0.0` 为占位包，无二进制）   |
| `@bysking/b-code-darwin-x64`   | macOS Intel 二进制                            | 同上                                     |
| `@bysking/b-code-linux-x64`    | Linux glibc 二进制                            | 同上                                     |
| `@bysking/b-code-win32-x64`    | Windows 二进制                                | 同上                                     |

为什么拆成 5 个包：二进制 ~75MB/平台，塞进一个包会让用户下 300MB。拆开后 npm 用
`os`/`cpu` 字段只装匹配的那一份。

### 关于 4 个平台包的 `1.0.0` 占位版本

npm 的 Trusted Publishing **只能给已存在的包配置**，所以这 4 个平台包在实现功能之前，
先手工发布了 `1.0.0` 占位版本——只含 `README.md` + `package.json`（~1KB），
**不含任何可执行文件**，仅用于占住包名、让 OIDC 配置成为可能。

主包的 `optionalDependencies` 始终等于主包 `version`（当前 3.2.x），与占位的 `1.0.0`
不匹配，所以用户**不会**装上占位包——这是预期行为。等真实版本发布后，占位版本自然被
取代（无法删除，npm 不允许复用已发布的版本号，但它不会被安装）。

---

## 一、日常发版（已配置好 Trusted Publishing 之后）

```bash
# ① 改版本号——只改一处
#    package.json 的 version
#    4 个平台包的版本由 scripts/sync-version.js 在 prepack 时自动派生，
#    源文件的 package.json 里根本不存在 optionalDependencies 字段

# ② CHANGELOG.md：把 [Unreleased] 内容移到新版本小节并标日期

# ③ 提交后打 tag
git tag v3.2.1 && git push origin v3.2.1
```

### 版本号为什么只改一处

主包的 `optionalDependencies` 必须指向**与主包同版本**的 4 个平台包，否则用户
`npm i -g` 时静默解析失败（症状是"装成功了但 `bcode` 跑不起来"）。原来这 4 行要手工
跟 `version` 一起改，共 5 处，极易漏。

现在改为**发布时注入**：

```
package.json 的 version（唯一手改）
      ↓ prepack: sync-version.js --inject
tarball 里的 optionalDependencies（自动 = version）
      ↓ postpack: sync-version.js --restore
源文件恢复原状，git 里永远看不到该字段
```

好处：源文件与 `bun.lock` 里都不会留下会漂移的版本号。想确认派生结果：

```bash
node scripts/sync-version.js          # 打印将派生的 4 个版本
npm pack && tar -xzOf *.tgz package/package.json | grep -A6 optional
```

CI 的 `check-version` job 会打一次真实包并断言 tarball 内 4 个平台包版本 == 主包版本，
注入逻辑被改坏时会在发布前拦住。

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

### 全新包第一次发布：唯一需要 token 的场景

npm 目前**不支持用 OIDC 发布一个尚不存在的包**
（[npm/cli#8544](https://github.com/npm/cli/issues/8544)，仍 open；PyPI 支持，npm 不支持）。
**包一旦存在，之后所有版本都能走 OIDC。**

这 4 个平台包已经通过发布 `1.0.0` 占位包解决了这个问题（见文首），所以**当前不需要 token**。
只有将来新增平台包（比如 `linux-x64-musl`）时才需要重走一遍。

那一步的做法：发一个只含 README + `package.json` 的占位版本，把包名占住即可。

workflow 同时支持两条路，按 secret 是否存在自动选择：

| 配置                    | 行为                                                     |
| ------------------------- | ---------------------------------------------------------- |
| 配了 `NPM_TOKEN` secret | 写入 `.npmrc`，用它发布。OIDC 仍会优先尝试，token 是回退 |
| 没配 `NPM_TOKEN` secret | 纯 OIDC（**当前状态**）                                  |

**新增平台包时的完整步骤：**

1. 在 npmjs.com → Access Tokens 创建 **Granular Access Token**，必须：
   - **勾选 `Bypass two-factor authentication`**（默认是**关闭**的，不勾会报 `EOTP`，见下）
   - Permissions 选 `Read and write`
   - Packages and scopes 选 `All packages`（或至少覆盖 `@bysking` 下的包）
   - 设一个够用的过期时间（至少 1 天）
2. 发布占位包（`package.json` + 一个说明用途的 README，不要放二进制）
3. 到该包的 Settings → Trusted Publisher 配好 OIDC
4. **吊销 token**——它是一次性的，不要留在账号里

> **为什么必须勾 Bypass 2FA**：npm 只保留 granular token，而它的 `Bypass 2FA` **默认关闭**。
> 关闭状态下用它发布，npm 会要求输入一次性密码（`EOTP`），而 CI 没有交互终端，必然失败。
> legacy/classic token 已被 npm 移除，不要照着旧教程找「Automation token」。
>
> 另外，Bypass-2FA 的直接发布能力**正在被 npm 废弃**（官方文档已标注 deprecated，未来
> 只能走 staged publishing）。这也是尽早切 OIDC 的另一个理由。

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

### 跨 job 传递二进制：必须用 tar，不能直接传目录

`build` job 编译完后要通过 artifact 传给 `publish-platforms` job，这一步**必须打包成
tar 再上传**（`archive: false`）。原因见
[upload-artifact 官方文档的 Permission Loss](https://github.com/actions/upload-artifact#permission-loss)：

> File permissions are not maintained during zipped artifact upload.
> All directories will have `755` and all files will be `644`.

也就是说，`pack-platform.js` 里 `chmod 755` 设好的执行位，会被这次 zip 中转**静默抹掉**。
v3.0.1 首次发布时就踩了这个坑：registry 上的 tarball 里 `bcode` 是 `644`，用户
`pnpm add -g` 安装后执行 `bcode` 直接报：

```
启动 bcode 失败：spawn .../bcode EACCES
```

这类问题**只在用户机器上才暴露**——CI 全绿、`npm publish` 成功、registry 也有包，
但装下来就是跑不了。当前的三重防线：

| 防线 | 位置 | 作用 |
|---|---|---|
| tar 打包上传 + `archive: false` | `build` job | 从源头保住权限位 |
| 解包后 `chmod +x` + `Verify exec bit preserved` | `publish-platforms` job | 双保险，并在发布前硬校验 |
| `pack-platform.js` 里的 mode 检查 | 本地/CI 打包时 | 打包后立即发现缺少 `+x`，不等用户报错 |

排查时可自查已发布的包：

```bash
npm pack @bysking/b-code-darwin-arm64@<版本> && tar -tvzf *.tgz | grep bcode
# 期望 -rwxr-xr-x，若是 -rw-r--r-- 说明执行位丢了
```

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

- 源 `package.json` 里**没有残留** `optionalDependencies`（有则说明注入后没还原）
- 平台清单在 `scripts/sync-version.js` / `bin/bcode.js` / `lib/index.js` /
  `scripts/pack-platform.js` **四处**一致
- `files` 覆盖 `main` 与 `bin` 所在目录
- （CI 传入时）git tag 与 `package.json` 版本一致

平台包版本与主包的一致性则由**打包后**校验：CI 的 `check-version` job 会 `npm pack`
一次并断言 tarball 内 4 个平台包版本 == 主包版本。这条最要紧——npm 对
`optionalDependencies` 的解析失败是**静默**的，版本号漂移的症状是用户
「装成功了但 `bcode` 跑不起来」，不会在安装时报错。

两处校验都已挂到 `prepublishOnly`（本地 `npm publish` 自动跑）和 CI 的
`check-version` job（发布前跑）。

---

## 六、排错


| 症状                                                            | 原因                                                  | 处理                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| **`EOTP` / `This operation requires a one-time password`**       | token 没勾 `Bypass two-factor authentication`（granular token 默认不勾），npm 要求交互式输 OTP，CI 无终端 | 重新创建 token 并**勾上 Bypass 2FA**；或改用 OIDC（已发布的包都支持） |
| `E404` / `ENEEDAUTH`，但 token 明明是对的                       | Trusted Publisher 没配到**这个**包上，或配了但包名/仓库/文件名填错 | 逐个检查 5 个包的 Trusted Publisher 配置             |
| 日志里 `Failed token exchange ... package not found`            | 该包在 registry 上**根本不存在**                     | 发一个 `1.0.0` 占位包占住包名（见「全新包第一次发布」） |
| `npm publish` 成功但 `curl` 仍是 404                              | npm 索引延迟，正常现象                               | 等几分钟；`+ pkg@ver` 已打印就是发出去了             |
| **用户装完执行报 `spawn ... EACCES`**                           | 发布的 tarball 里二进制是 `644`，执行位被 artifact 的 zip 中转抹掉 | 见「跨 job 传递二进制」；用 `tar -tvzf` 自查已发布包 |
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
