# 项目指令：dsh-codearts-auth
## 深细节索引（按需读，不进每轮注入）

以下主题的**事故史与逐项规则**已搬到 `docs/agent-notes/`（每节逐字节原样保留）。
**触发条件命中时才读对应文件**——改某 provider 前先读它的笔记；做 UI 前读 client-ui；
动协议/网关/积分前读 protocol-wire。别凭印象改：这里的每一条都是踩过坑的。

- `docs/agent-notes/dev-tasks.md`：「常见开发任务」的**调试与协议排障**细节（主文件只留导航表）
- `docs/agent-notes/misc.md`（8 节）：⚠️ 两条通用判据：一文件两套同义判据 / `String(undefined)`（PR !62）；⚠️ 包装适配器时必须包 `prepareCall`，不是 `stream`（PR !66）；项目概述（十个 provider 的协议源流与差异总览）；⚠⚠️ 客户端**不得**注册 `settings.models.provi；⚠️ dsh peer 范围必须**枚举并集**，不能用 `^0.1.2-r；LobsterAI 模型列表（三个易踩的坑）；…
- `docs/agent-notes/providers-qoder.md`（2 节）：⚠️ 安装（git 插件）的 allowBuilds 键在 pnpm 10 / 11 语义**互不兼容**（Issue IKJCOC）；⚠️ 额度类业务码**不是一个值，是一条链** —— 只认 `110` 会让换号静默失效（Issue IKKJFH，码值腿 + 文案腿必须同时在）
- `docs/agent-notes/client-ui.md`（23 节）：⚠⚠️ 注入的 `<style>` **必须署名 `data-plugin`**，否则被别的插件认领后连带删除（Issue IKK764）；⚠⚠️ 一键签到的汇总**必须按单位分列**，不得跨单位求和（2026-10-04）；⚠ 「通用面板」里的按钮与弹窗**必须按 provider 分支**（Iss；账号池与多账号（含模型饱和 14003 不许换号）；模型黑名单（Jet Hub「显示列表」开关）；⚠⚠️ **判「某个 id 在不在目录里」时两个目录来源（`listModels` / `listAllModels`）必须取并集**（Issue IKJW33：只用任一个都被实测证伪 —— 冷缓存下 `listAllModels` 是编译期兜底**子集**（cline 实测 3/460）⇒ 误报；而 `opencode` 的 `listAllModels` 恒兜底表 + `listModels` 匿名身份只给免费模型 ⇒ 反向误报 13/13；另含「黑名单必须在 `await` 之后读」与「源码级断言必须锚定片段、并列断言必须用计数」两条测试教训）；⚠⚠️ **「关闭全部/关闭供应商」写黑名单前必须取同一份并集，且「远端读到但为空」也要判**（同一个 `fullCatalogIds` 缺陷的另一入口：远端 `[]` + 兜底表 1 条 ⇒ 只关那 1 条却返回成功 ⇒ 供应商**显示已关闭而模型仍可选**；判据**已按端点分道**（2026-08 修订，别再统一成 `complete`）：`provider.setEnabled` 判 `remoteError`（读到但为空要照常关闭，否则无账号供应商永远关不掉）、`model.setAllDisabled` 判 `complete` 但**并集已全在黑名单时幂等成功**（「全部已关闭」会让 `listModels` 被过滤成 `[]`、与「无账号」同形，不幂等就会误报「没有可关闭的模型」），`account.test` 是刻意例外「尽力而为」不得改拒绝）；目录门控：没有已登录账号就隐藏整个 provider；⚠⚠️ **额度错误的码不得被客户端替换**（Issue IKJVCW：harness 常量 `QUOTA_EXCEEDED_CODE` 的字面值就是 `'QUOTA'`，客户端会丢掉 message 换成「当前请求的额度已用尽」；额度须用字面量 `'QUOTA_EXCEEDED'`，四处产出点缺一不可，含 `httpErrorCode` 的 401/403 短路；⚠️ **不要给 codearts 加「地域封锁」判据** —— 141 个真实会话零命中，那套 marker 是从 cline 照搬的，已撤回）；…
- `docs/agent-notes/protocol-wire.md`（16 节）：⚠⚠ RPC 的 `catch` **不得**把失败包成 `ok:true`（Issue IKJOZA）；⚠️⚠️ **网关监听地址**：容器/端口映射下默认 `127.0.0.1` 使映射**永不可达**（Issue IKL7UN），修法是 `DSH_OPENAI_GATEWAY_HOST` 可配 + **拒绝通配地址**；⚠️⚠️ 通配判据**绝不能交给 `new URL()` 规范化**（初版如此、注释自称「无假阴性」，被两轮独立审计实测证伪：`::%eth0` / `::\u200b` / `[::]:8326` 等 14 条 fail-open），而**修法本身也被后两轮各证伪过一次** —— 不可见字符**必须按 Unicode 类别**（`\p{Cf}\p{Cc}\p{Cs}\p{Mn}\p{Me}\p{Zs}\p{Zl}\p{Zp}`）**+ NFKC**，**枚举码点必漏**（`Cf` 有 160+ 个，且 `\u034f` CGJ 是 `Mn` 不是 `Cf`；实测 25 条可绕）；⚠️⚠️⚠️ 更关键的是**「认不出来就放行」这条路线本身必须废弃**（fail-closed）—— 内核把 **`U+3002` 表意句号**（`Po`，NFKC 不折）当 `.`，实测 `0。0。0。0` **真绑全部网卡**；最终修法是加 `isLegalHostText` 只放行 `[A-Za-z0-9.:%_-]`，**先字符闸门（fail-closed）→ 再通配识别（放行未知）**；且**「判据串」与「listen 串」必须分两个函数**（判据剥 zone id、返回值保留 —— 剥了会让 Linux link-local `fe80::1%eth0` 绑不上）；IPv4 还要兼容 `inet_aton` 紧凑写法（`0`/`0x0`/`00`/`0.0.0.0.` 在 Linux 上都是 `0.0.0.0`）；且**必须同步改四处把 127.0.0.1 当常量的 UI/日志文案**（客户端回环判据必须**复用宿主侧实现**，自己写正则会立刻漂移成假阳性）；⚠️ 网关请求体超限**必须是 413、不能是断连**（Issue IKKUBJ：销毁 socket 让 413 发不出去 ⇒ 客户端只看到连接重置、会话永久不可用；上限还须与自家图片声明自洽、`keepAliveTimeout` 必须显式设置）；⚠️ 图片必须按像素预算发**请求版本**，不能恒发原图（Issue !IK；⚠️⚠️ 该节的两条**已实测边界**（Issue IKKX0T）：**报文里的 `100001` 是常量哨兵 = `limit+1`，与张数无关**（12/15/20 三档报的都是它）⇒ **不能拿它反推每张 token**（「15 张估算 99,579、差 0.4%」那条是**巧合式吻合**，已删除）；且 **`617 px/token` 只在小图上成立**（1721×997 → 601~618；2560×1600 → 410~492 px/token，面积涨 2.39× 而 token 涨 3.25×）⇒ `DEFAULT_IMAGE_PIXEL_BUDGET` 的「约 96 张」是**乐观端**（悲观端约 64 张），引用余量必须带区间；buddy 边界应读作**区间 `(8,15]`** 而非「= 15」；单次输出上限（`maxOutputTokens`）必须下发，不能只用来过滤；⚠️ 持久化：DSH 0.1.7 移除 `settings.register；⚠️ 「锁定永久积分」三家**共用一张表与一个端点**，但判据必须各算；…
- `docs/agent-notes/providers-buddy.md`（5 节）：模型计费倍率与同名模型（必须写进 `name`，不是 `descriptio；⚠️ CodeArts benefit（免费额度）模型：集合必须动态判定，不；⚠⚠️ 腾讯系内容级风控：system 里的客户端模板句会被**整轮拦死**
- `docs/agent-notes/providers-cline.md`（4 节）：⚠️ Cline provider：`workos:` 前缀不可剥、免费集合；⚠️ Cline 限流：倒计时用**报文里的人类可读时长**，402 不许倒；⚠⚠️ **模型目录构建的 O(N²)**（Issue IKL3YH：`remoteModels.find` 热点 + `resolveModel` 每次整份重建目录；N=471 实测 312ms → 1.5ms；缓存失效判据必须按**数组身份**不能按长度，兜底表还须记忆化否则缓存被架空）
- `docs/agent-notes/providers-trae.md`（2 节）：TRAE（字节跳动）协议要点（五个易踩的坑）；⚠️ 流内 `code=4006`（体积超限）**不得**归 `SERVER`（Issue IKKX0T：原先落 `SERVER` ⇒ 巨型请求体被**原样重发 5 次**；修法是抽出 `streamErrorCode()` 逐格表，4006 → `CONTEXT_WINDOW_EXCEEDED` 以**兼得「不重试」与「触发溢出压缩」**；⚠️ 4001 与 4006 不可合并、`502+HTML` 刻意不动）
- `docs/agent-notes/providers-loomy-raccoon-minimax.md`（3 节）：⚠️ Loomy（讯飞）provider：五个不能凭直觉改的点；⚠️ Raccoon Work（商汤小浣熊）provider：不能凭直觉改的；⚠️ MiniMax Code（中国版）provider：不能凭直觉改的点（§8.7 = **请求级换号 + 冷却**与真机实测的错误报文形状，Issue IKJW32；⚠️ 该家写标记后**必须**同时在 `probeById` 与 `WRITES_RATE_LIMIT_PROVIDERS` 里，否则标记清不掉）
- `docs/agent-notes/backup.md`（7 节）：⚠️ **账号备份**：三种「只加不覆盖」的语义边界（选账号导出 / 合并导入 / 第三方转换）；裁剪必须在**发请求之前**且要裁三处；合并导入的判重是**三层**（第 2 层身份字段是关键，含 `IDENTITY_FIELDS` 候选表）；`AccountPool.mergeAccounts` 只调 `writeAccounts`；与「永久积分锁定表」的交叉点；与 `pruneAccountsWithForeignDomain` 的交叉点（残余风险）；测试与反向验证表
- `docs/agent-notes/providers-opencode.md`（1 节）：⚠️⚠️ OpenCode 出口代理：dispatcher 与 fetch **必须同源**（Issue IKK4BY）—— 外部 undici 的 dispatcher 配全局 fetch 会在 Node 22/24 上恒抛 `UND_ERR_INVALID_ARG`（内置 6/7 与外部 8 的 handler 契约不同源），必须走 `proxyFetch`；`fetch failed` 的真因在 `cause` 里
- `docs/agent-notes/providers-zcode.md`（6 节）：⚠️ ZCode（智谱）provider：「卡住 + 停止按钮无效」的两个根；⚠️ ZCode 上游节流三件套（吸收自 `dsh-free-glm`，20；⚠️⚠️ `3012` 的 HTTP 状态码是 **405**（不是 403；⚠️ ZCode captcha 的真实形状（2026-10-01，3.14；⚠️⚠️ **额度按模型分桶**（8M = 3M `glm-5.3` + 5M `glm-5.3-flash`，判据是上游下发的 `capabilities: ["model:<小写 id>"]`）——折算层据此写池的按模型标记；四个最易写错的格（通用桶必须参与 / 证据不足不得判死 / 查不到不得判死 / 写标记**不得沉底**）与大小写陷阱（上游小写 vs 目录大写）；⚠️⚠️ **独立审计（53 个变异）查出的两个真缺陷**：① **死锁** —— 折算取号按 `probeModel` 过滤，而它恰是被标记的模型时账号被筛空 ⇒ **折算根本不跑** ⇒ 标记永不清除 ⇒ 整条渠道消失（修法：取号传空 `modelId`）；② **误封整天** —— 额度下发成字符串时 `num()` 判 0 ⇒ 写持久标记锁死账号（修法：`unreadableBuckets` 守卫）；另含「接线零守卫（删掉 158 条全绿）」「abort 被 `catch` 吞掉」与三条审计纪律
- `docs/agent-notes/providers-kukuai.md`（7 节）：⚠️ 库库AI（百度 GenFlowPro）provider 的**实测**事实，**与 `docs/superpowers/specs/...-design.md` §1.5/§4 冲突时以它为准**：登录态**全明文**（`encrypted_value` 长度全 0，不需要 DPAPI）；`freepoint/homenew` 必需的**常量** query（`clienttype=400&app_id=123971023&web=1&channel=chunlei&version=1.6.8`，缺则 `errno=2 params error`，而源码里传的是空对象 `{}`）；**余额不在 `homenew`** 而在 `/bizapi/gfpro/getgfvipremain`（取 `data.list` 里 `assetType===1`，`totalPoint` 是**字符串**）；**领积分是写操作**（`POST freepoint/rewardClaim`，参数放 **query** 且请求键是 `period_id` 而值取响应的 `period_no`）—— design doc 说的「服务端自动发放」与「`autoClaim` 自动领取」**均已被实测推翻**；IDE 是 **cookie 登录不是 OAuth**，且三步都不依赖 IDE
- `docs/agent-notes/providers-accio.md`（10 节）：⚠️⚠️ **Accio（阿里）provider 的三条「与参考实现相反」的实测结论**：**有标准 OAuth 2.0 + PKCE（`client_id='accio-work'`，公开客户端）⇒ 可完全脱离 IDE**（不需要读本机 `credentials.enc`、不需要 DPAPI）；⚠️⚠️ **推理请求不需要 SecurityGuard 签名**（不带 `pctb-x-*` 同样 200 ⇒ 不需要 `security_guard.node` 与那串阿里 DLL，参考实现把它当必需是过度设计）；⚠️ 但 **token 必须放 body 的 `token` 字段**，放 `Authorization` 头恒**流内 402**（HTTP 仍是 200 ⇒ 不看流内 `error_code` 会误判成「成功但没内容」）。⚠️⚠️ **两个真缺陷**：① **`cmd /c start` 会把授权 URL 在第一个 `&` 处截断**（cmd 把 `&` 当命令分隔符）⇒ 症状极具误导性：登录页误弹「请升级客户端」+ `explorer` 弹出**文件管理器**窗口 + 回调永不到达；必须用 `rundll32 url.dll,FileProtocolHandler`；② **`expires_at` 秒/毫秒混淆**（上游给**秒**，当毫秒用会判定「永久过期」⇒ 每请求续期 ⇒ 烧掉 refresh_token ⇒ 账号被标死，与 codearts 单向门同型；归一化只在兑换/续期返回处做**一次** + `> 1e12` 防御分支）。⚠️⚠️ **实施阶段真机推翻设计的一条**：**`system_instruction` 必须是字符串，不是 Gemini 的 `{parts:[…]}` 对象** —— 对象形态恒回 **HTTP 200 + 流内 400**（最难看的一种失败），官方 proto 两处都用 `String()` 归一；**教训可推广：「同族」只共享信封骨架，不共享每个字段的形状，逐字段仍要拿官方 proto 核对**。⚠️⚠️ **接线陷阱（新 provider 通用）**：新注册的 provider **必须**同时进 `src/jet-hub-rpc.ts` 的 `SELF_HEAL_REFRESHABLE_PROVIDERS`（除非设计上无 refresh 端点，那要在 `credits-balance-self-heal.spec.ts` 的显式豁免表写明理由）—— **漏登记则过期账号在积分端点永不自愈**（症状与 issue IKKHL5 逐字相同：积分行报「未登录」而上游只需一次 refresh），且**日志零字**；该守卫原本只有正向、反向缺失，**accio 就是这么漏掉的**，现已补反向用例逐键点名。⚠️ 同理 `src/jet-hub-store.ts` 的 `ACCIO_ACCOUNT_*` 前缀表、`src/aggregate-adapter.ts` 的参与渠道清单、`src/provider-registry.ts` + `provider-runtime.ts` 两张注册表**缺一处都是静默失效**。⚠️ **`rateLimit: false` 的判据**：该渠道**根本不写 `modelRateLimits`、也不在 `probeById` 里** ⇒「重测 / 重置」点下去**零请求、零清除**（恒惰性），与 loomy/gemini「真会限流但按钮管辖不到」**理由不同**；⚠️ 「省略 = true 以免老用户失去按钮」那条**不适用于全新 provider**（无存量用户，无功能回退可言），将来接上请求级换号 + 冷却时**本行要一起改回 true**。⚠️ **「刷新每日额度」入口尚未实现**（面板刻意不渲染该按钮）：它本质是重新登录**既有**账号，需宿主侧**新增一条 RPC**（如 `account.relogin`）—— 现有 `account.create` 恒新造 id 与凭据 ref（拿它重登会造**幽灵账号**而原账号额度一点没刷新）、账号 `region` 没下发给客户端、`login.poll` 对已登录账号立刻回 `done: true`（假成功）⇒ 三条障碍；在那之前面板只做诚实展示（三类积分桶 + 重置倒计时 + 「删除该账号后重新登录」这条手动路径），文案**不得**写死每日额度数字（上游一调整就自相矛盾）。⚠️ 一条**方法论**教训：写对照矩阵时**必须检查每个变量是否真的独立** —— 把赋值写在公共路径上会让**所有格子共享它**，「四格都成功」≠「四个变量都被验证」（`sgcookie` 就这么被漏掉一轮，补做的干净对照才证明它也不必需）。另含：登录页 legacy 门禁真源（CDN 上的 `kiIt5C4K.js`，**不在 asar 里**）、积分「没有签到端点但**登录触发**按日发放」（`DAILY_REWARD 200`，24h、不累积）、15 个模型与倍率（0.013~2.8，**倍率必须进 `name`**）、工具调用**分片到达且共享消费者不合并**（须由适配器合并，否则 harness 把同一工具执行 N 次）、**思考关不掉但档位生效**（⚠️ 2026-10-13 修订：旧结论「四类字段实测全部无效 ⇒ 不声明档位」**已推翻**——旧探针用的是**非法值**且拿**思考字符数**当判据；重测见下）、与 Qoder **同属阿里但协议完全不同**（别照 Qoder 写）；⚠️⚠️ **但聚合渠道里必须把它当 Qoder 那样处理**（用户 2026-10-13 要求「聚合当中的 qwen3.8-flash 轮换列表里要有」）：accio 的 `modelCode` 是 `1Drift-…` 内部代号，**与 qoder 的 `qfmodel` 完全同因** ⇒ ① `canonical-models.ts` 的 `PRIMARY_CHANNEL` 必须加 `accio: 'name'`（否则它的每个模型各成一个孤立虚拟模型、跨渠道聚合**完全不发生**，症状**静默**：它只是不在候选表里）；② 同时需 `CANONICAL_OVERRIDES.accio` 把 `1Drift-F8hS3mK7pL2n` 显式指到 **`qwen3-8-flash`（无连字符）** —— accio 的展示名 `Qwen 3.8 Flash` 有空格 ⇒ name 通道得 `qwen-3-8-flash`（**多一个连字符**），而 loomy/trae/qoder 走 id 通道（id `qwen3.8-flash` 无空格）得 `qwen3-8-flash`，**同一模型被拆成两个键**；⚠️ 补丁**只加确知同模型的**（`Qwen 3.8 Max` 本来就一致、**无需**补丁；`27B`/`A3B`/`Standard`/`Professional`/`Ultimate` 是独立模型，猜着并入 = **请求打到错的模型且无提示**）；⚠️⚠️ **思考档位**（用户 2026-10-13 要求「用远端真实下发的档位、即使只有一档也要显示」）：**推翻了旧结论**「四类字段全部无效 ⇒ 目录里不声明档位」—— 旧探针用的是**非法值**（`off`/`none`/`minimal`，都不在远端声明的 `low`/`medium`/`high`/`xhigh`/`max` 里）且拿**思考字符数**当判据（同档内波动 186~490，信噪比太低）；改用**服务端权威计数 `thoughts_token_count`** 重测，Ultimate 五档中位数**单调递增 33→40→41→43→43** ⇒ 档位**真实生效**（但「**关不掉**」成立：`low` 也有 33 token ⇒ 会话命名仍走抬预算兜底）；⚠️ 远端 38 条里 **31 条 `efforts=null`**，其中 **6 条只给 `defaultReasoningEffort`**（GLM-5.3/5.2/5.3 Flash=`max`、DeepSeek V4.1 Flash/V4 Pro=`high`、MiniMax M3=`adaptive`）—— 实测**发过去服务端接受** ⇒ 是**真实单档**（正是「只有一档也要显示」那一格）；落地 `accioReasoningOf`（三格：有数组⇒全列且 `defaultEffort` 必须落在集合内否则丢弃它／只有 default⇒**单档**／都无⇒不声明）+ `normalizeAccioModel` 解析；⚠️⚠️ **另一条真缺陷：`utdid` 不带会被风控拦截**（实测：真实值与**自造随机值**都 ✅、**完全不带**或**只放 header 不放 `properties.utdid`** 都 🚫）—— 风控响应是 **HTTP 200 + `content-type: text/html`**（跳转脚本 `bixi-intl.alicdn.com/punish/…` + `rgv587_flag:sm`），**不校验 content-type 就会静默退化成「模型未返回内容块」**（本轮探测被它误导过一轮）；已在 `stream()` 加 content-type 校验（归 `SERVER`、不重试）；⚠️ 目录端点不带 `utdid` 也正常 ⇒ 该约束**只在推理路径暴露**；⚠️⚠️ **对外 id 用「人话」slug、上行仍用 `modelCode`**（用户追问「为什么回复中的模型不是标准模型 id」）：DSH 把 `CatalogEntry.id` **注入给模型当身份**，而上游 `modelCode` 是 `1Drift-N8kP2Q7wR5mX` 这类**故意不可读**的内部代号 ⇒ 模型只能自报乱码；改为 `accioModelIdOf`（= `normalizeNameKey(展示名)`，**与聚合共用同一套归一**，不自己写第二份）产出的 slug（`qwen-3-8-flash`），**但上行必须经 `accioModelCodeOf` 反查回 `modelCode`** —— 服务端只认后者，漏映射的症状是「**模型不回复**」（不是参数错误，极具误导性）；⚠️⚠️ **连带失效**：`CANONICAL_OVERRIDES` 的索引键按 `realId` 查，而聚合读的是 `listModels` 的 `id` ⇒ id 改 slug 后**补丁索引也必须改成 slug**，否则恒不命中 ⇒ accio 掉回孤例键 ⇒ **聚合轮换列表里又看不到它**且无任何报错
- `docs/agent-notes/provider-abstraction-g3-exceptions.md`：⚠️ 2026-10-08 provider 能力抽象重构（计划 1）**做不到「零行为变化」（G3）的 6 处例外**逐条登记（含基线 `ecbb268` → 现行的**可观测量**与变异验证结论）。**动 provider 抽象层、或核对「重构是否改变了行为」前先读它**：5 处确为行为变更（凭据损坏文案 / `account.refresh` 分派 / `onboarding.claim` 错误码 / `codearts` 未知 id 模态 / `buddy` 消歧集合）、1 处（签到文案）逐字节未变只是搬了位置，**5 处已于 2026-10-08 逐条复核后全部接受**；⚠️ 另一条独立教训：**「登记了一处例外」≠「这处例外有守卫」**，必须逐项变异验证（当时实测出 G3-4 **零守卫**）

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释说明、总结、文档）一律使用中文。
- 代码标识符、关键字、类型名称、变量名等保持英文不变。
## 技术栈与约束

- **Node.js**：`^22.19.0 || >=24.0.0`
- **构建系统**：宿主侧用 TypeScript `tsc` 编译到 `lib/`；客户端 bundle 用
  `esbuild`（`plugin-src/client/build.mjs`）打包到 `lib/client/jet-hub.js`。
  两者都产出到已 gitignore 的 `lib/`，`prepare` 执行 `pnpm build:all` 保证
  git 安装时两侧产物齐全。
  ⚠️ **`tsc` 不清理「源文件已删除」的产物**：改名/删文件后 `lib/` 会留着旧的
  `.js` / `.d.ts` / `.map`（2026-10-01 把 `cline-modalities.ts` 换成
  `cline-models-dev.ts` 时实测到，`lib/cline-modalities.*` 四个文件仍在，
  并随文件拷贝式安装一起进了 profile）。**删改源文件后手动清一次 `lib/`**
  （或整目录重建），否则残留模块虽无人 import 却会一直跟着发布。
  ⚠️ **`plugin-src/client/jet-hub-styles.js` 里的 `STYLES` 是模板字符串 ——
  CSS 注释内绝不能出现反引号**。用它给属性名加强调（`` `min-width: 0` ``）会
  **提前闭合模板**，esbuild 报 `Expected ";" but found "min"` 并把指针指到注释那一行，
  看起来像 CSS 写错了，实际是 JS 语法问题（2026-10-01 改页头样式时踩过，
  一次引入 6 对）。注释里要强调就直接裸写 `min-width: 0`。
  改完这个文件**必须跑一次 `pnpm build:client`** —— 单测只读源码文本，不会因此失败。
- **测试**：Vitest（单元测试 + E2E 端到端测试）
  - `pnpm test` — 单元测试（快速，无网络，全部 mock）
  - `pnpm test:e2e:*` — 端到端测试，按 provider 分列（如 `test:e2e:codearts`、`test:e2e:buddy`、`test:e2e:workbuddy-claim`）；**均有闸门，默认全部跳过**，详见 `tests/e2e/README.md`
- **依赖管理**：pnpm workspace（作为 DSH 插件安装）
- **代码风格**：与 `@deepseek-ai/dsh` 主仓库保持一致
## 项目结构

| 路径 | 说明 |
|-------|------|
| `src/` | TypeScript 源码目录（宿主侧） |
| `plugin-src/client/` | Jet Hub 客户端源码（esbuild 打包） |
| `lib/` | 编译产物（已 gitignore；含 `lib/client/jet-hub.js`） |
| `tests/unit/` | 单元测试 |
| `cordis.patch.yml` | DSH bundle 补丁 |
| `tsconfig.json` | TypeScript 配置 |
| `vitest.config.ts` | Vitest 配置 |
## DSH 插件契约

- 插件使用 `@deepseek-ai/dsh` 的 `credentials`、`commands`、`llm` 服务注入
- 凭据存储使用 `ctx.credentials` 模块，ref 格式遵循 POSIX 标识符（如 `CODEARTS_ACCESS_TOKEN`）
- LLM provider 通过 `ctx.llm.registerProvider()` 注册
- 命令通过 `ctx.commands.register()` 注册
- 插件配置通过 `ctx.schema` 在 profile layer 栈中声明
## 工作方式

### ⚠️ 子任务优先用 **inline** 执行，不要新开 subagent

处理多任务计划（如 `docs/superpowers/plans/*.md` 的 Task 1..N）时，**新子任务直接在
当前会话 inline 做**，不要为每个子任务再新开 subagent。用户 2026-09-29 明确要求。

理由（本项目实测的代价）：
- **同一工作区无法安全并行**：subagent 做「反向验证」时会在源码里注入**临时变异**
  （未提交状态）。此时若另一个 subagent 跑全量测试，会看到 2~3 条**不属于它的**失败，
  容易误判为自身缺陷；更糟的是若它执行 `git stash` / `git checkout -- .` /
  `git restore` / `git add -A`，会**毁掉**前者的变异验证（丢未提交的变异体与还原基线）。
- **subagent 会长时间空转**：本项目已有两次复审 subagent 跑到超时仍无产出
  （Task 2 的复审者被 `interrupt_agent` 中止、Task 4 的复审者未输出即结束）。
- **context 更可控**：inline 做时前面已建立的实测事实（协议细节、坑点、
  既有范例行号）都在手边，不必每次重新交代，也不会因为表述遗漏而让子代理
  重新踩已知的坑。

若确实要用 subagent（例如任务之间**没有文件重叠**且**都不做变异验证**），必须：
1. 预先告知它「工作区可能有他人未提交改动，**只 `git add` 自己的文件**」；
2. **明令禁止** `git stash` / `git checkout -- .` / `git restore` / `git add -A`；
3. 告诉它判断成败要用**自己的**测试文件，全量测试只作参考。

### `ctx.xxxAuth` 服务统一接口

本插件定义的所有 `ctx.xxxAuth` 服务（`codeartsAuth`、`buddyAuth`、`workbuddyAuth`、`lobsteraiAuth`、`qoderAuth`、`qodercnAuth`、`traeAuth`、`clineAuth`）均遵循统一接口：

- `login(options?)` — 执行浏览器登录流程
- `startLogin(options?)` — 两步式登录（先返回 loginUrl，Jet Hub 据此弹窗）
- `refreshAccountCredential(refName, pool?, accountId?)` — 按凭据 ref 续期**指定账号**（账号卡片「刷新」按钮）。⚠️ 后两个参数**必须传**：只有拿到池与账号 id，续期后的新 `expiresAt` 才能回写账号池（见下）
- `refreshAll(pool)` — 批量续期全部账号（定时调度器）

⚠️ **不注册任何斜杠命令**：十个 provider 的登录/状态/续期**全部**在 Jet Hub 设置页完成。

⚠️ **CodeArts 只支持账号池，单凭据模式已移除**（用户要求）：

- 凭据一律存 `CODEARTS_ACCOUNT_XXX`；固定的 `CODEARTS_ACCESS_TOKEN`
  **不再被写入或读取**（常量保留仅为兼容 `login`/`startLogin` 的 `refName` 缺省值）。
- 只服务于单凭据路径的方法**已删除**：`status()` / `refresh()` / `logout()` /
  `scheduleRefresh()` / `scheduleModelRefresh()`（后两者当时就没有调用方）。
  `refreshModels()` **签名改为接收 `pool`** —— 它原先直接读固定 ref，
  移除单凭据后会恒返回空列表。
- `codearts-login` / `codearts-status` / `codearts-refresh` 三个命令**已删除**
  （注意代码里**从来没有** `codearts-logout` 命令，logout 只是服务方法）。
- 十个 provider 的门控判据因此**完全一致**：都只看账号池，
  `providerCatalogVisible` 的 `extraCredentialRefs` 参数已随之删除。
- 老用户影响：若此前只用固定 ref 登录过，模型列表会变空，需在 Jet Hub 重新登录一次
  （用户已确认接受该行为，不做自动迁移）。

### ⚠️ 续期不得按 `enabled` 过滤

`refreshAll()` 与 `src/index.ts` 的续期调度器**只按 `refreshable` 过滤，不看 `enabled`**。

⚠️ **「不看 `enabled`」这条仍然有效；「按 `refreshable` 过滤」这条已被推翻**
（2026-10-02，见下文「账号池的 `refreshable` 只是凭据材料的镜像」）：
那个布尔当过滤条件用会把一次瞬时失败固化成单向门，账号从此永不自愈。

停用只应影响「账号池的自动选号」，与「凭据是否需要保持新鲜」无关 ——
停用账号同样会出现在 Jet Hub 里并参与积分领取。

**真实缺陷**（用户报障）：两个**曾停用**的 CodeBuddy 账号显示「凭证过期」，
点「一键领取积分」报 `Unexpected token '<', "<html> <h"... is not valid JSON`。
根因是两处都按 `enabled` 过滤：

- `refreshAll()` 里的 `if (!entry.enabled || !entry.refreshable) continue`
  → 停用期间 refresh_token 一路放到失效；
- `src/index.ts` 的 `accounts.some(a => a.refreshable && a.enabled)`
  → **所有账号都停用时续期定时器根本不启动**。

用户重新启用后拿到的是死凭据，只能重新登录。十个 provider 的
`refreshAll`（`buddy-auth.ts` / `service.ts` / `lobsterai-auth.ts` / `qoder-auth.ts` / `trae-auth.ts`）与调度器
**都必须保持只看 `refreshable`**。

⚠️ Qoder 中国版**复用同一个 `QoderAuth` 类**（`src/qoder-auth.ts`），故它的
`refreshAll` 判据**天然与国际版一致** —— 不存在「CN 那份实现忘了改」的可能，
这正是「差异收敛到产品配置」这个模式的价值。

### ⚠️ 续期三件事缺一不可：启动先跑一轮、lead-time 判据、回写账号池

**真实缺陷**（Gitee issue !IKIRTT，用户报障）：重启后 cline / codearts / raccoon
的账号卡片**最长 30 分钟**显示红色「有效期：已过期 · 自动续期」，积分行报
`账户信息查询失败：HTTP 401`，而凭据其实是好的（`refresh_token` 到 10 月）。
点「刷新」按钮凭据续成功了、**界面纹丝不动**，点「重测」也不救急
（`src/account-probe.ts` 的 `refresh` 是**刻意**的 no-op，探测不该触发全局续期）。

根因是多账号改造丢了三条语义，三者**必须同时在**（缺任何一条都还会看到症状）：

1. **启动首轮**：`src/index.ts` 的调度器原先只有 `setInterval`，第一次处理要等满
   一个周期。短寿命令牌（cline 1h / codearts 约 2h / raccoon 3h，对照 buddy 系 720h）
   在宿主关闭期间早已到期 → 只有这三个 provider 会暴露出来。
   现在 `pool.listAllAccounts()` 门控通过后**立刻** `void refreshAllCredentials()`。
   ⚠️ 那条链原本**没有 `.catch()`**：`listAllAccounts()` 一 reject，定时器永不武装
   且日志零字 —— 「30 分钟」会恶化成「永不自愈」。
2. **lead-time 判据**：`shouldRefreshNow()`（`src/expiry-sync.ts`）复用单凭据时代
   `REFRESH_LEAD_MS`（1 小时）—— 距过期不足 1 小时才发续期请求。
   这既让启动首轮只打 0~3 个请求（39 账号的池不会在启动时突发几十个请求），
   也终结了「八个 provider 的 `refreshAll` 没有任何过期判据、每 30 分钟全量轮换」。
   ⚠️ **判据必须用凭据自己的 `exp`，不能用账号池的 `expiresAt`** ——
   池值正是本缺陷里可能陈旧的那份数据，拿它当尺子会漏刷真正快过期的账号
   （读凭据只是本地存储访问，不花网络也不花模型额度）。
   ⚠️ **raccoon 保留更严的「已过期才刷」**（`isRaccoonExpired`，lead=0）：
   它 3 小时寿命 + 30 分钟定时器已足够，提前 1 小时刷只会多打请求 ——
   lead-time 的目的是**减少**请求，不是增加。别「为统一」把它改成 1 小时。
3. **回写账号池**：UI 读的**只**是池里的 `expiresAt`
   （`plugin-src/client/jet-hub.js` 的 `account.expiresAt <= Date.now()`）。
   原先十个 provider 里只有 raccoon 回写，其余八个（含 `createPoolRefresh` ——
   CodeBuddy 系**发消息途中**按需续期的路径，触发频率远高于点按钮）
   只 `credentials.set` → 「数据源分叉」，功能完全正常但界面永远错。
   现统一走 `src/expiry-sync.ts` 的 `syncAccountExpiry` / `refreshAccountWithReconcile`。

⚠️ **`refreshAll` 里「本轮不刷」的分支绝不能直接 `continue`** —— 必须仍做一次
有效期对账。只修「续期时回写」是不够的：**存量账号**的凭据早已在别处（IDE /
上一轮）续好，判据必然为「不用刷」，池里的旧值就**永远无人更正**。
判据用「与凭据不一致」（不是「池值已过期」），否则漏掉「池值偏小但尚未过期」。
一致时不写盘（账号列表是整体落盘的），容差 1 秒（JWT 的 `exp` 是秒级）。

四个必须记住的实现约束：

- ⚠️ **`isLoomyRefreshable` 恒为 `false`**（Loomy 没有 refresh 端点，是诚实标记）。
  故 `ExpiryAccessors.refreshableOf` 是**可选**的，Loomy 那份不提供 ——
  否则共享实现会把池里的 `refreshable` 写成 false，与该产品的设计自相矛盾。
- ⚠️ `findAccountIdByCredential` 的第二参是**凭据内容**不是 ref 名（传 ref 名会
  恒匹配失败且**静默**）；且 codearts 比对的字段是 **`access_key_id`**（它的凭据里
  根本没有 `access_token`）；它还**跳过 `enabled === false`** 的账号。
  ⇒ 调用方已知 `entry.id` 时**必须显式传**，反查只是兜底。
- ⚠️ 回写失败**只记日志、不上抛**：凭据已经续期成功了，因写索引失败而报错会让
  用户以为续期失败、甚至触发无谓的重新登录。
- ⚠️ 凭据里读不到过期时间时**不覆盖**池内旧值：`updateAccount` 做的是
  `{ ...entry, ...patch }`，写 `undefined` 落盘会被 `JSON.stringify` 整个丢弃，
  UI 于是从「已过期」变成「未知」—— 保留旧信息更有价值。

⚠️ 边界（别夸大这类缺陷）：**功能一直是好的** —— 适配器发现凭据过期会按需
`refresh()` 再发请求；定时器跑过一轮后 UI 也会自愈。受影响的是「启动到首轮之间」
的界面与积分行，以及窗口内点「刷新」看不到变化。

可观测性（同一 issue 的第 5.4 条）：`src/index.ts` 原先有**十个**
`catch { /* 静默 */ }`，把 provider 内部告警与异常一起吞掉。现收成
`refreshTargets` 表驱动 + 一处 `ctx.logger.warn`。
⚠️ `src/service.ts`（codearts）此前**整份文件零 logger**，而它的令牌最短命 ——
续期失败将完全无痕，现已补 `refreshAll` 两个分支的日志。

测试：`tests/unit/expiry-sync.spec.ts`（lead 边界含 `<=`、一致不写盘、
1 秒容差、不传 refreshableOf、反查传凭据内容、回写失败不反噬、
「有效期内仍须对账」、续期返回 undefined 时绝不落盘）+
`tests/unit/refresh-bootstrap-wiring.spec.ts`（启动首轮排在定时器前、
**每个 channel provider** 都在表里、九个 auth 的 `refreshAccountCredential`
都带 pool/accountId 且真调共享回写、RPC 与 `createPoolRefresh` 都传 id）。

⚠️ **这里刻意不写条数**：原文写「（19 条…）」而 2026-10-08 复审实测该文件已 **21** 条
（12 个 `it` + `it.each` 展开）—— 条数是**必然腐坏**的快照，接一个 provider
就会失效，而「数字对不上」会让人怀疑整段约定。**条数以 `pnpm test` 输出为准。**

### ⚠️ 账号池的 `refreshable` 只是**凭据材料的镜像**，绝不能当续期门禁

**真实缺陷**（用户报障 2026-10-02）：「我们插件的 codearts 账号池出现 2 个 401 未认证，
自动续期没有工作吗？重启也还是 401」。

本机取证（只读 `~/.dsh/jet-hub/state.json` + `~/.dsh/.credentials.yaml`）：

| 事实 | 值 |
|---|---|
| 两个 codearts 账号在池里 | `refreshable: **false**`（9-25 的快照里同两条还是 `true`）|
| 凭据本体 | **完好**：`refresh_token` 还剩 18 天寿命（到 10-18）、`code_verifier` 64 位、`dpop_private_key_jwk` 都在 |
| 凭据的 `expires_at` | 停在 12 小时前那次成功续期上，此后**再没被写过** |
| 整个池 | 36 条里 **33 条** `refreshable:false`（loomy 4 + zcode 2 是诚实的 false）|

⇒ 旧实现 `refreshAll()` 第一行 `if (!entry.refreshable) continue` 把这个布尔变成了
**单向门**：任何一次把它写成 false 的事件之后，该账号**永不进入续期循环** ——
定时那轮跳过它、启动首轮也跳过它，于是「自动续期没工作、重启也没用」，
而凭据明明还能用。**这正是上一节「只按 `refreshable` 过滤」那条约定的代价**，
该约定已被本节修订，见下文。

**三条已落地的规则**（`src/service.ts` 的 `CodeArtsAuth.refreshAll`）：

1. **调度判据读凭据，不读池值**。`isCodeArtsRefreshable(credential)`
   （`refresh_token` + `code_verifier` + `dpop_private_key_jwk` 三样齐全）
   才是「能不能续」的权威；池里的 `refreshable` 是**每轮由凭据对账出来的结果**，
   不是「曾被服务端拒绝过」的案底。误标会在下一轮自动改回 true（自愈）。
   只有**凭据确实缺材料 / ref 下没有凭据**才写 `false`，且写前先比现值
   （`if (entry.refreshable)`）—— 定时器每 30 分钟一轮，别重复整体落盘。
   ⚠️ 读凭据只是**本地存储访问**，不花网络也不花模型额度 ——
   拿它当门禁来「省请求」是**错省**，省下的是自愈能力。
2. **判终态前先重读凭据**：续期被拒（`invalid_grant`）时，先看磁盘上那份
   `refresh_token` 是否**已经不等于**本次用来续期的那一份。并发下服务端烧掉的是
   **旧的**一份，而磁盘上此刻躺着一份**新的、可用的**凭据 —— 那是「他处已续成功」，
   不是「本账号不可续期」。少了这层判据，一次交错就把好账号永久标死。
   命中时改用**最新凭据**对账（`syncAccountExpiry`），不发终态标记。
3. **`InvalidDPoPHeader` 不算 refresh_token 失效**（`src/oauth.ts` 的 `requestToken`）。
   旧判据把它与 `invalid_grant` 并列为终态，注释写的理由是「避免每 10 分钟无限重试」，
   实际代价是一个**材料完好**的账号被标死、用户只能重新登录。DPoP proof 没过校验
   说的是「**这一次**证明不合格」（时钟偏差让 `iat` 落在窗口外 / proof 被判重放 /
   网关抖动），与「refresh_token 还能不能用」无关；归为可重试的代价只是 10 分钟后再发
   一个 HTTP 请求。终态只留 `invalid_grant` 与 `ExpiredRefreshToken`。

4. **调度器的武装门也不能读 `refreshable`**（`src/index.ts`）：原先是
   `accounts.some(a => a.refreshable)` 才武装定时器 —— 用**可能被误标的字段**
   决定「要不要启动修误标的机制」是循环依赖。本次事故实测 36 条账号只剩
   3 条 `true`（raccoon / minimax / cline 各一），再少三条，
   **codearts 的自愈与启动首轮会一起消失且日志零字**。现改为「池里有账号就武装」；
   各家 `refreshAll` 内部本就按凭据材料 / 是否过期过滤，放宽这里最多多一次本地遍历，
   不会白发请求。⚠️ 仍然**不看 `enabled`**（上一条铁律未变）。

**为什么会被标死：三条续期入口并发消费同一份 `refresh_token`。**

① `src/index.ts` 每 30 分钟（含启动首轮）的 `refreshAll`；
② 推理路径的按需续期（`llm-adapter.ts` 的「过期预判」与「401 兜底」，
   而 DSH 本身会**并发**发多条请求：主回复 + 标题生成 + 上下文压缩）；
③ Jet Hub 账号卡片的「刷新」按钮（`account.refresh`）。
华为 STS 在签发新凭据时**旧的那一份 refresh_token 即失效**，
并发下必然「1 个成功、其余 `invalid_grant`」，而失败方把它读成「账号不能续期」。

⇒ 已加 **per-`credentialRef` 的 `SerialQueue`**（`CodeArtsAuth.refreshQueues`）：
三条入口在同一进程内必然串行，且**锁内重读**凭据 —— 仍在有效期内就直接对账返回，
不再发第二次请求（少烧一次 token）。
⚠️ **该锁只在单进程内有效**：同一台机器上 dsh web 与 desktop 两个实例各自持锁，
跨进程互踩只能靠上面第 2 条兜 —— **两处都得有，少一个就会复发**。
（用户环境实测就是 web + desktop 两个 profile 都装了本插件。）

**可观测性**：真终态时日志带上**服务端原文**（`…；服务端原文：CodeArts token request failed: 400 {…}`），
且同一 ref 同一原因**只告警一次**（`terminalWarned`）—— 真失效时用户要做的是重新登录，
每 30 分钟重复同一行只会把有用信息埋掉。

⚠️ **本条修订「续期不得按 `enabled` 过滤」一节里的说法**：那句
「`refreshAll()` 只按 `refreshable` 过滤」现已不成立 —— `refreshable` **不再是过滤条件**，
而是被对账的字段。「不看 `enabled`」这条**仍然有效**（停用账号照旧要续）。

⚠️ **其余八个 provider 仍有同一个单向门**：buddy / workbuddy / lobsterai / qoder /
qodercn / trae / cline / minimax 的 `refreshAll` 第一行都还是
`if (!entry.refreshable) continue`，而取证时它们的账号**同样**大面积被标 false
（buddy 4/4、lobsterai 4/4、trae 4/4、qoder 5/5、qodercn 3/3、workbuddy 5/5 ——
凭据里 `refresh_token` 全都在）。本次只修了用户报障的 codearts；
推广时**三条规则要一起带**（读凭据对账、判终态前重读、per-ref 串行），
只搬第一条会继续误标。

测试：`tests/unit/service.spec.ts` 的「CodeArtsAuth refreshAll：以凭据为准的自愈」
（7 条：误标后自愈且**只回写一次**、缺材料才标 false、已 false 不重复写盘、
并发重放不误标且用最新凭据对账、真终态照标 false 且不损坏凭据、
单账号失败不中断其余、同一 ref 并发续期只发一次请求）+
`tests/unit/oauth.spec.ts`（`InvalidDPoPHeader` 归可重试、`ExpiredRefreshToken` 仍终态）。
⚠️ 已做**反向验证**：加回 `if (!entry.refreshable) continue` → 自愈用例变红；
队列改 `new SerialQueue({ enabled: false })` → 并发串行用例变红（实测 2 次请求）；
去掉「判终态前重读」→ 并发重放用例变红；把 `InvalidDPoPHeader` 加回终态判据 →
oauth 用例变红。四条各自独立锁死，**别把它们当同义反复删掉**。
⚠️ 已做**反向验证**：去掉 lead 过滤 + 去掉「一致不写盘」→ 7 条变红；
去掉启动首轮 + 去掉 cline 回写 → 3 条变红（含行为用例「刷新后池内
`expiresAt` 指向未来」，非同义反复）。
⚠️ 接线类断言一律用 `(pool|p)` / `[^)]*` 容忍重构与签名扩展 ——
写死整串会让每加一个 provider 或每补一个参数都假失败（该教训已记在
`cline-adapter.spec.ts` 的注释里）。


服务名由产品 id 派生（`${product.id}Auth`）：两个 `BuddyAuth` 实例分别注册为 `buddyAuth` 与 `workbuddyAuth`，`LobsteraiAuth` 注册为 `lobsteraiAuth`，两个 `QoderAuth` 实例（同一类、不同 `product`）分别注册为 `qoderAuth` 与 `qodercnAuth`，`TraeAuth` 注册为 `traeAuth`，`ClineAuth` 注册为 `clineAuth`，互不覆盖。

⚠️ 服务名撞车会**在构造时抛** `service "..." has been registered`，故新增同族产品时
**provider id 必须互不相同** —— 这也是 `qodercn` 这个 id 不带连字符的原因
（`qoder-cnAuth` 不符合 camelCase 惯例）。

各 provider 的登录/续期机制不同（详见 README.md），但均通过 `ctx.credentials` 统一管理凭据生命周期。
## ⚠️ DSH 0.1.7 把工具结果改为一等 `role:'tool'` 消息（消息形状双兼容）

**真实缺陷**（用户报障）：升级到 DSH **0.1.7** 后，带工具调用的会话出现
「**没有工具调用就认为对话结束**而提前停止」或「**模型陷入循环思考**」。

### 根因：`tool-result` 包裹块被删除，工具调用被整体剔除

0.1.7 重构了消息模型：

| | ≤0.1.6 | 0.1.7 |
|---|---|---|
| 工具结果承载 | `role:'user'` 内嵌 `{type:'tool-result',toolCallId,content,isError}` | **一等 `role:'tool'` 消息**，`toolCallId`/`isError` 在**顶层** |
| `ContentBlockMap` | 含 `'tool-result'` | **删除 `'tool-result'`**，新增 `'tool-addition'`/`'tool-removal'` |
| 角色 | system / user / assistant | 新增 **`tool`**、**`developer`** |
| `StreamChunk`（插件产出） | — | **逐字节未变** |

⚠️ **`StreamChunk` 没变，所以产出侧（`stream()`）完全不用改** —— 坏的只是
**消费**方向（harness 传给适配器的 `options.messages`）。

各适配器都按 `type === 'tool-result'` 识别工具结果，该判据在 0.1.7 下**恒不命中**：

1. 工具输出被当成普通 user 消息下发，`tool_call_id` 关联丢失；
2. `resolveToolPairing` 的 `allResultIds` 恒为**空集**
   → `usable.every(block => allResultIds.has(...))` 恒 false
   → **assistant 的 `tool_calls` 被整体剔除**。

wire 上于是完全没有工具调用记录，模型看到的是「我说了段话，用户回了段工具输出」。

**实测**（真实 session `session-54cbd95c`，2492 行 v3 日志经 0.1.7 解析器迁移）：
修复前保留 **0** 条工具调用，修复后 **512** 条，与 0.1.5 形状对照完全一致。

⚠️ **0.1.7 没有任何协议协商机制**：`packages/llm` 里 `LlmAdapter` / `GenerateOptions`
都没有版本协商字段（搜到的 `protocolVersion` 全属 ACP，与 LLM 适配器无关）。
所以**不能靠协商规避**，必须让代码同时认两种形状。

### 修法：形状归一化层，不改五个序列化实现

新增 **`src/message-shape.ts`**，把 0.1.7 形状**降级**为既有代码已理解的 0.1.5
形状，各入口只插一次调用：

- `normalizeHarnessMessages(messages)` —— 一等 `tool` 消息 → 包回
  `{role:'user', content:[{type:'tool-result',...}]}`；`developer` 消息**丢弃**
  （它只承载工具增删元数据，不是对话内容）；其余原样透传。
- `detectMessageShape(messages)` —— 判据用**形状**而非版本号（沿用
  `settings-compat.ts` 的能力探测先例），且**同时出现两种形态时以 `tool-role` 为准**
  （升级期会话可能混合；判成 legacy 会让新形态结果被漏掉，等于没修）。

⚠️ **`content` 数组必须整体保留、不压平** —— 既有实现依赖内嵌 `image` 块做图片
提升（工具结果内嵌图片须挂到其后的独立 user 消息），压平会让图片静默丢失。

⚠️ **`developer` 的剥离与形状探测相互独立**：`detectMessageShape` 只回答「工具
结果长什么样」，而 `developer` 是 0.1.7 专有角色，**无论有没有工具结果都要剥离**。
两者必须分别求值，否则「无工具结果的会话」会把 `developer` 当普通 user 消息下发。

⚠️ **无需改动时返回原数组引用**（`===`），保证 0.1.5 路径**逐字节**不受影响。

落点（6 处）：`sse.ts` 的 `resolveToolPairing`（共享防线，须自身独立正确）、
`llm-adapter.ts` / `openai-compat.ts` / `buddy-adapter.ts` /
`lobsterai-adapter.ts` / `trae-adapter.ts` 的 `serializeMessages`。
`qoder-adapter.ts` 复用 `openai-compat.serializeMessages`，自动受益。

⚠️ **`resolveToolPairing` 的 `content` 参数放宽为可选**（归一化层产出的类型允许
缺 content；函数内部本就按「非数组即视为空」处理）。这是**纯放宽**，不改变行为。

### 回归用例

- `tests/unit/message-shape.spec.ts` —— 探测/归一化/幂等/身份返回/真实字段布局
  （含 `source.callId` 回退：顶层 `toolCallId` 缺失时不能丢 id）。
- `tests/unit/message-shape-adapters.spec.ts` —— **核心不变式**：同一份语义数据按
  两种形状喂入，`serializeMessages` 输出**逐字节等价**。比逐个断言字段更强，
  且对实现方式中立。
- `tests/unit/session-replay.spec.ts` —— **真实会话回放**（离线只读，无网络）。
  自造 fixture 可能在真实数据上失效，故用真实会话锁死。需 `DSH_SESSION_FIXTURE`
  指向导出文件，未设则**干净 skip**（⚠️ 文件必须**惰性读取** —— `describe.skipIf`
  仍会执行回调体收集用例，顶层 `readFileSync(undefined)` 会让整份套件变成
  Failed Suite 而非 skip）。
- `scripts/export-session-messages.mjs` —— 只读导出真实会话消息。
  ⚠️ 必须用 `createSessionFormatCatalogWithChildren([])`（**不是**默认 catalog）：
  V3→V4 迁移要求显式提供子会话事实，无子会话时传**空数组**，否则 `createStage`
  抛 `SessionFormatUnsupportedMigrationError`。

⚠️ **验证「修复有效」必须做反向验证**：临时让 `normalizeHarnessMessages` 恒返回
原数组（= 修复前行为），确认用例**会失败**。否则可能写出一组恒真的同义反复。
## 常见开发任务

### 新增功能

1. 确定所属模块（auth 服务 / 命令 / provider）
2. 在 `src/` 对应文件中实现逻辑（客户端 UI 改 `plugin-src/client/`）
3. 添加单元测试覆盖
4. 执行 `pnpm build:all` 编译（host + client 两侧）
5. 执行 `pnpm test` 验证
6. 更新文档

### 调试

- 使用 `pnpm typecheck` 快速验证类型
- E2E 测试需要设置环境变量 `DSH_CODEARTS_E2E=1`（测试在打开的浏览器中需要人工点击授权）
- 构建错误检查 `lib/` 目录是否存在以及 `tsconfig.json` 的 include/exclude 配置
- ⚠️ **改完插件必须重建 `lib/` 并重启 DSH 才生效**：宿主侧代码在 DSH 启动时从
  `lib/index.js` 载入，不热重载（只有 `plugin-src/client/` 的客户端 bundle 有 HMR）。
  **排查「改了没效果」时先看这两个时间**：`lib/index.js` 的 mtime 与 DSH 进程的启动时间 ——
  进程早于产物就说明跑的是旧代码。
- ⚠️ **不重启还有第二种后果：新 provider 的账号可能从池里消失**（2026-10-13 观察到的现象）
  - **观测事实**（可复核）：`state.json` 里 accio **2 条 → 0 条**，而
    `.credentials.yaml` 里的 `ACCIO_ACCOUNT_*` **两条凭据完好**（都还剩 ~719 小时）；
    同时 `providerOrder` **不含 accio**；Web 进程启动 `10/12 19:59`，
    含 accio 的 `lib/jet-hub-store.js` 编译于 `10/13 17:38`（**进程比产物早 ~22 小时**）。
  - ⚠️ **机制未确证，别照抄推测**：一度怀疑是「旧进程的陈旧 `cache` 整体回写抹掉它」，
    但**决定性实测证伪了该假设** —— 构造「载入时无 accio → 外部往磁盘加 accio →
    对无关账号做一次写操作」的序列后，**accio 仍存活**。
    ⇒ `AccountPool` 的整体回写**不会**凭旧 cache 删掉它（`sanitizeAccounts` 不按
    provider 过滤）。**真因尚未定位**，候选：DSH settings scope 的 schema 裁剪、
    客户端的 provider 列表驱动写入、或某条按 provider 白名单的写路径。
  - ⇒ **实用结论（仍成立）**：加完新 provider 后**重启 DSH**（web + desktop
    两个 profile），既为让新代码生效，也避免这类「新旧混跑」造成的账号池异常。
  - ⚠️ **凭据与账号池不同命**：账号池条目丢了**只是界面看不见**，
    `.credentials.yaml` 里的凭据仍在 ⇒ 探针/测试**直读凭据即可**，不依赖账号池。

#### ⚠️ 「没有任何报错就中断」怎么查

这类现象**无法靠读代码推断**，必须回到会话记录。DSH 把每次请求的**原始 chunk 流**
也记进了 `assistant/message` 事件（`data.stream`），据此可还原真相：

```bash
node scripts/inspect-session.mjs list zed                      # 找会话（工作区关键字）
node scripts/inspect-session.mjs turns <会话文件>               # 每轮结束原因（先定位可疑轮次）
node scripts/inspect-session.mjs brief <会话文件> assistant/message 700
node scripts/inspect-session.mjs stream <会话文件> <seq>        # 该步的原始 chunk 流（关键证据）
```

会话日志位于 `~/.dsh/sessions/<工作区转义名>/<session-id>/session.v3.jsonl.zstd`
（**zstd 压缩的 JSONL**；工作区名把 `\` `/` `:` 换成 `-`，如
`D:\jet\code\rust\zed` → `--D-jet-code-rust-zed--`）。

判据（真实案例，2026-09-23，`qoder`/`qfmodel`）：同轮相邻两步对照 ——

| 步骤 | chunk 流 | finish |
|---|---|---|
| 正常步 | `block-start(text) → text → block-start(tool-call) → tool-call-chunks → block-end×2` | `tool-calls` |
| 中断步 | `block-start(text) → text →`（**无任何 tool-call**）`→ usage → block-end` | `stop` |

即：模型写完「让我检查 X：」后流就结束了。**`turn/end` 是 `completed`**，
UI 上完全看不到错误。

⚠️ 两个可能成因，**不要凭猜认定**：
1. **连接被掐断**（没有 `finish_reason`、也没有 `[DONE]`）→ 已由
   `consumeOpenAiSse` 的 `truncatedStream` 判定改为报 `max-tokens`（可重试）；
2. **模型确实输出了 `finish_reason: stop`** 却没产出工具调用（模型抖动）→
   本层无从强制，但此时**行为可与 (1) 区分**：修复后 (1) 会重试、(2) 仍是 `stop`。
   若重启后再现且仍不重试，说明是 (2)，需换思路（如减少单步工具数量）。

**其它已修的同族缺陷**（都表现为「无报错中断」，改 `openai-compat.ts` 时务必保留）：

- **网关形态错误帧被整帧丢弃**：帧形如
  `{"stackTrace":[...],"message":"...","statusCodeValue":400}` ——
  **既没有 `code` 也没有 `error`、也没有 `choices`**，早期解析器所有条件都不命中。
  现按 `statusCodeValue >= 400` 或带 `stackTrace` 判为错误并抛出。
> ▶ 本节其余内容见 `docs/agent-notes/dev-tasks.md`（按需读）。

## LLM Provider 约定

- provider 名称：`codearts` / `buddy` / `workbuddy` / `lobsterai` / `qoder` / `trae`
- 端点格式为 OpenAI 兼容
- 请求签名/鉴权方式因 provider 而异：
  - `codearts`：华为云 `SDK-HMAC-SHA256` 签名方案
  - `buddy` / `workbuddy`：Bearer access_token + 额外自定义头（`X-Product-Code` 随产品切换）
  - `lobsterai`：Bearer access_token + `X-LobsterAI-Client-*` 头（**无签名**，也**不带**腾讯系归属头）
  - `qoder`：推理请求头**由 WASM 生成**（含签名），**必须原样透传**，不能自行构造；请求体加密。积分余额端点另走纯 `Bearer`。
  - `trae`：`Cloud-IDE-JWT <token>` + `X-Cloudide-Token` / `X-Ide-Token` / `X-Uid` / `X-Machine-Id` / `X-Device-Id` / `X-Ide-Version` 等十余个身份头（**无签名**，**不带** JSON-RPC 包装）
- provider 在 `ctx.llm` 上注册，配置在 profile 中可选
- `buddy` 与 `workbuddy` 共用 `BuddyAdapter`，行为差异全部由 `src/product.ts` 的 `BuddyProduct` 配置驱动；新增同源产品只需加一份配置并注册实例
- `lobsterai` 用独立的 `LobsteraiAdapter`（协议不同源，见项目概述）；它的产品配置是 `src/lobsterai-product.ts` 的 `LobsteraiProduct`，与 `BuddyProduct` **平行而非继承**
- `qoder` 用独立的 `QoderAdapter`（协议不同源，见项目概述）；产品配置是 `src/qoder-product.ts` 的 `QoderProduct`，同样**平行而非继承**。它的 OpenAI 协议层逻辑复用 `src/openai-compat.ts`
- `trae` 用独立的 `TraeAdapter`（协议不同源）；它的产品配置是 `src/trae-product.ts` 的 `TraeProduct`，同样**平行而非继承**。与其它四个 provider 最根本的差异是**载荷与响应都要转换**：请求体经 `transformToSOLOBody` 转成 SOLO 格式，响应经 `parseTraeSSELine` 从 SOLO 自定义 SSE 转成 OpenAI chunk

## ⚠️ 两张注册表：`PROVIDER_REGISTRY`（数据）与 `PROVIDER_RUNTIME`（实现）

2026-10-08 的 provider 能力抽象重构引入了**两张职责不同的注册表**。
新增 provider 时**必须知道改哪张、以及为什么**。

### `src/provider-registry.ts` —— **纯数据**，零 import

各家的**元数据与能力声明**（id / 展示名 / 图标 / `channel` / `credits` /
`permanentLock` / `usesExpiryWindow` / `accountTest` …）。

- ⚠️ **必须零 import**：它同时被 Node 宿主（`tsc`）与浏览器客户端（`esbuild`）使用，
  任何 `node:*` 依赖都会让客户端打包失败。客户端的能力表（
  `plugin-src/client/credits-capabilities.js`）**从它派生**，不再手抄。
- ⚠️ **provider id 一律纯小写字母**（不带连字符）—— 它同时是 cordis 服务名
  （`${product.id}Auth`）、LLM 路由名与客户端 key。`qodercn` 不带连字符正因如此。

### `src/provider-runtime.ts` —— **实现**，运行时按 id 查表

各家的**能力实现**（`auth` / `credits` / `onboarding` / `expiry` / `probe`），
在 `apply()` 里经 `registerProviderRuntime({ descriptor, auth, … })` 注册。

- ⚠️ **`registerProviderRuntime` 重复注册时保留先注册者、返回 `false`、不抛错**：
  本仓库有**实测的 fiber 重启竞态**（新 fiber 的同步 `apply()` 与旧 fiber 的异步
  `dispose()` 交错），抛错会让整个插件加载失败。
- ⚠️ **读注册表建索引的派生表必须是函数，不能是模块级常量**：
  `wiredRefreshTargets()` / `registeredRuntimeIds()` 读的是注册表，而注册发生在
  `apply()` 里 ⇒ 模块级常量在**模块加载时**求值，会恒为空表。**症状是静默的**
  （所有 provider 都不再自动续期，日志里只有常规输出）。有用例锁住。
  ⚠️ **纯数据清单不受本条约束**：`src/aggregate-expiry.ts` 的
  `WIRED_EXPIRY_PROVIDERS` **刻意保持常量**（它不是从注册表读出来的索引，
  改动会波及 29 处探针 + 86 处适配器构造），它与 runtime 的一致性改由
  `expiry-runtime-parity.spec.ts` 真跑 `apply()` 的用例锁死。
  别照搬本条去改那张表。
- ⚠️ **查表用 `Object.hasOwn` / 导出的 `xxxOf()` 助手，不要用下标**：
  `table[id]` 会命中原型链上的键（如 `constructor`），与 `authOf` 同因。

### 抽象边界：**编排可抽象，协议不抽象**

设计文档 §3.5 的边界。已抽出的**编排**骨架（`credential-resolver` /
`model-catalog` / `provider-credits` / `provider-onboarding` / `provider-expiry` /
`buddy-balance-selector`）只回答「**选哪个原语、按什么顺序**」；
各家的**协议**实现（签名、端点、载荷转换）留在各自模块内，**不强行统一**。

⚠️ **形态确实不匹配的家要如实排除，不要为「凑齐 N 家」而丢语义**：
`codearts` 的 `resolveCredential` 无 fallback 且不收 `modelId`（不纳入
`createCredentialResolver`）；`opencode` 的门控/黑名单/模态/context 与
`createModelCatalog` 有 5 处协议级差异（不纳入）；`loomy` 的 reason 类型与
`BuddyBalanceSelector` 结构不兼容（保留自己的分支）。

### ⚠️ 三类**静默失效**及其防线（重构时逐条核对）

| 失效形态 | 症状 | 防线 |
|---|---|---|
| **漏接一家** | 该家凭据永不自动续期 / 重测标记永远清不掉，**日志零字** | 派生表 + 从 `PROVIDER_REGISTRY` 派生的用例（漏一家**点名**） |
| **位置/键错位** | 中国版账号用国际版凭据续期（历史复发 6 次） | 命名对象形参（`JetHubAuths`，键 = provider id）+ 逐 provider 断言「恰好自己那个实例被调」 |
| **「未知」被写成「否定」** | 图片静默发不出去 / 或发到不支持的服务端 | `inputModalities` 三态（省略 = 未知，`['text']` = 明确不支持）+ 双向用例 |

⚠️ 另有两条**注释级**陷阱（本重构各踩过多次）：
- **不要引用行号**（`foo.ts:123`）—— 最大的文件 4000+ 行，每次重构都会失效。
  **按符号名引用**。
- **不要在注释里写出「会被验收 grep 的字符串」**（被删的符号名、`foo(` 形态）——
  会让「该符号应不存在」这类检查失效。

## ⚠️ 移植既有实现的轮换/重试语义：先抄「类别→动作」表，不是抄循环骨架

**真实事故**（2026-10-06，PR #64 的 raccoon/loomy 轮换）：照 `buddy-adapter.ts`
的**循环骨架**（tried 集合 + `getAvailableAccount(exclude)` + 换号重发）给两家补了
请求级轮换，但**漏抄了 buddy 的分支语义表** —— buddy 只在**限流类**失败写冷却标记，
认证类（401/403）只 `continue` 换号**不写标记**。初版写成「凡可换号就写冷却，
时长 `status===429 ? 1h : 24h`」⇒ 上游网关对全池回 401（`authorization_verify_error`）时，
**一个请求内 6 个号各被封 24h，整个 provider 死一天**（症状
`no usable credential; log in first`）。

**审查侧规则**（给 code-review 与自审）：看到「对齐/移植/参照既有实现」的 PR，先要
那张**类别→动作**表，再逐格对照源实现 —— 骨架长得像不代表语义抄全了：

| 问 | 为什么 |
|---|---|
| 源实现把失败分几类？判据是什么？ | 分类是语义的载体（quota/rate/auth/other 各自动作不同） |
| 每类**换不换**下一个候选？ | 换号无益的类别（400 参数错）不该换 |
| 每类**写不写**状态标记（冷却/黑名单）？ | 认证类写冷却＝把网关故障放大成全池不可用（本次事故格） |
| 每类**抛什么错误码**？ | 401 报成 `QUOTA_EXCEEDED` 会误导排障与重试策略 |
| 候选耗尽时报什么？带不带最后一次的真实原因？ | 笼统报错丢服务端原文（buddy 上同款教训） |

新实现必须配**逐格回归测试**（每格一条，先红后绿）；漏抄的那格就是将来的事故。

### ⚠️ 同族判据必须**逐格同构**，改一侧就要改另一侧（2026-10-06 同型复发）

`classifyRaccoonFailure` 与 `classifyLoomyFailure` 是**同一张判据表的两个实现**。
raccoon 在 `7b524ff` 收窄后 loomy **未同步**，于是同一报文在两个 provider 上被判成
**不同类别**，且危险方向恒定朝 loomy（多写冷却）—— 实测四例：

| 报文 | loomy（未同步时） | raccoon（已修） |
|---|---|---|
| `403 + insufficient permissions to access this resource` | `quota` ⇒ **写 24h** | `auth` ⇒ 只换号 |
| `403 + 积分不足` | `quota` ⇒ **写 24h** | `auth` ⇒ 只换号 |
| `401 + 余额不足` | `quota` ⇒ **写 24h** | `auth` ⇒ 只换号 |
| `400 + context window is insufficient for this model` | `quota` ⇒ **写 24h** | `other` ⇒ 不换号 |

前两行与上面的「全池被封」是**同一事故形态**，只换了触发词。两条不变式：

1. **401/403 先判**，恒归认证类 —— 状态码与额度文案并存时（网关侧故障常在报文里
   捎带余额提示）**以状态码为准**；
2. `insufficient` 单独出现**过宽**，必须与邻近的「钱」义词
   （`point` / `credit` / `balance` / `quota` / `token`）**共现**才算额度。
   方向是**宁可漏判不可误伤**：漏判只是不换号，误判会封可用账号 24h。

⚠️ **两侧各写一份用例挡不住复发**（单方面"改严"时两边各自的用例都能过）。
`tests/unit/loomy-adapter.spec.ts` 的「与 raccoon 对拍」段把**同一批真实报文
喂两个分类器、断言逐条同结论**，分叉即红 —— 这是防复发的真正闸门。

