/**
 * 銆屾笭閬撲綑棰?鈫?鏈€鏃╁け鏁堟椂鍒汇€嶇殑**鍞竴鍙ｅ緞**銆?
 *
 * ## 涓轰粈涔堝崟鐙竴涓枃浠讹紙鑰屼笉鏄苟杩?`aggregate-core.ts` / `aggregate-adapter.ts`锛?
 *
 * | 鍊欓€変綅缃?| 涓轰粈涔堜笉琛?|
 * |---|---|
 * | `aggregate-adapter.ts` | `auto-adapter.ts` 鐨?`expiryOf` 瑕佸鐢ㄥ畠 鈬?渚濊禆鏂瑰悜鍙樻垚 `auto-adapter 鈫?aggregate-adapter`锛?*灞傛棰犲€?*锛岃仛鍚堥€傞厤鍣ㄦ槸鏇翠笂灞傜殑涓滆タ锛?|
 * | `aggregate-core.ts` | 璇ユ枃浠跺畾浣嶆槸**绾€昏緫**锛堝摠鍏?/ 鎺掑簭 / 鍊嶇巼瑙ｆ瀽锛屾ā鍧楀ご鏄庡啓銆侀浂 import锛夛紝鑰屾湰妯″潡瑕佸彂缃戠粶璇锋眰 鈬?鎶?IO 娣疯繘绾嚱鏁版ā鍧楋紝涓?`aggregate-core.spec.ts` 杩欎釜绾嚱鏁板崟娴嬩細**琚揩鍔犺浇缃戠粶妯″潡** |
 * | 鉁?鏈枃浠?| 鍗曚竴鑱岃矗锛涗袱涓€傞厤鍣ㄩ兘渚濊禆瀹冿紝鏂瑰悜姝ｇ‘ |
 *
 * ## 鈿狅笍 鍥涗釜 `*Expiry` 鏄?*鎼Щ**杩涙潵鐨勶紝涓嶆槸澶嶅埗
 *
 * 瀹冧滑鍘熷厛绉佹湁鍦?`auto-adapter.ts` 閲岋紙`private async buddyExpiry` 绛夛級銆俆ask 7
 * 鎶?`expiryOf` 鏀规垚濮旀墭鏈ā鍧楃殑 {@link createExpiryProbe} 鍚庯紝鑻ュ師澶勫啀鐣欎竴浠斤紝
 * 灏辨垚浜?*鍚屼竴璇箟涓ゅ瀹炵幇**鈥斺€旀湰浠撳簱瀵规鏈夋槑纭殑绾㈢嚎璁板綍锛圓GENTS.md 棣栨潯鍒ゆ嵁锛?
 * `buddy-growth.ts` 鍥犱袱澶勫鍚屼竴瀛楁缁欏嚭鐩稿弽鍒ゆ嵁鑰屼骇鐢?*闈欓粯澶辨晥**锛氫笉鎶ラ敊銆?
 * 涓嶅穿婧冦€佸崟娴嬭兘杩囷紝鍙槸鎶娿€屾病鍋氬埌銆嶈鎴愩€屽仛鍒颁簡銆嶏級銆?
 * Task 3 宸茬敤鍚屾牱鎵嬫硶澶勭悊杩?`pickSoonestProvider` / `priceFactorFromName`銆?
 *
 * @module src/aggregate-expiry.ts
 */

import type { AccountPool } from './account-pool.js'
import { NEVER, UNUSABLE, type ExpiryProbe } from './aggregate-core.js'
import type { BuddyCredential } from './buddy.js'
import { fetchCreditBalance } from './credits.js'
import { CODEBUDDY, WORKBUDDY } from './product.js'
import { LOOMY } from './loomy-product.js'
import type { LoomyCredential } from './loomy.js'
import { fetchLoomyCreditDetail } from './loomy-credits.js'
import { fetchCodeArtsAccountInfoDetailed } from './codearts-credits.js'
import type { CodeArtsCredential } from './types.js'
import type { ZcodeCredential } from './zcode.js'
import { fetchZcodeBalance } from './zcode-upstream.js'
import { nextUtc8DayStartMs } from './model-queue.js'
import type { CreditBalance } from './credits.js'
import { LOBSTERAI, type LobsteraiProduct } from './lobsterai-product.js'
import type { LobsteraiCredential } from './lobsterai.js'
import { fetchLobsteraiCreditBalance } from './lobsterai-credits.js'
import { TRAE, type TraeProduct } from './trae-product.js'
import type { TraeCredential } from './trae.js'
import { fetchTraeCreditBalance } from './trae-credits.js'

/**
 * 鐪熷疄涓存湡鎺㈤拡锛?*姣忎釜娓犻亾鎶樼畻鎴愪竴涓€屾渶鏃╁け鏁堟椂鍒汇€?*銆?
 *
 * ## 閫愭笭閬撳垽鎹紙鍙ｅ緞涓?`jet-hub-auto` 瀹屽叏涓€鑷达紝鏁呭鐢ㄥ悓涓€濂楃鐐癸級
 *
 * | provider | 鍒ゆ嵁 | 渚濇嵁 |
 * |---|---|---|
 * | buddy / workbuddy / **lobsterai** / **trae** | 鏈夋晥璧勬簮鍖?`deductionEndTime` 鐨勬渶灏忓€硷紙**鍏变韩** `sharedPackageExpiry`锛?| `credits.ts` / `lobsterai-credits.ts` / `trae-credits.ts` |
 * | loomy | `daily > 0` 鈫?褰撴棩 24:00锛涘惁鍒?`permanent > 0 ? NEVER : UNUSABLE` | 鍛藉悕姹狅紝鏃犳椂闂存埑 |
 * | codearts | **`NEVER`锛堥暱鏈燂級** | 鈿狅笍 **鎶ユ枃鏃犱换浣曟椂闂村瓧娈?*锛堝疄娴嬩笁瀛楁鍏ㄧ┖锛夆噿 涓嶈噯閫?|
 * | zcode | 鍚勬《 `expiresAt`锛堢锛夋渶灏忓€硷紱鏃犲甫鏈熶綑棰濇椂鎸夊綋鏃?| `zcode-upstream.ts` |
 * | 鍏朵綑锛坬oder / qodercn / cline / raccoon / minimax / gemini / opencode锛?| **鏈彃浠舵湭鎺ュ叆** 鈫?`UNUSABLE` | 瑙佽璁℃枃妗?搂9.1 |
 *
 * ## 鈿狅笍 鏈帴鍏ョ殑娓犻亾蹇呴』杩斿洖 `UNUSABLE`锛?*涓嶈兘**杩斿洖 `NEVER`
 *
 * `NEVER` 鐨勮涔夋槸銆屽彲鐢ㄣ€佸彧鏄棤涓存湡棰濆害銆嶏紝瀹?*鍙備笌鎺掑簭涓斿彲褰撻€?*銆傝嫢鎶婁竴涓?
 * 灏氭湭瀹炵幇鐨勬笭閬撴姌绠楁垚 `NEVER`锛屽畠浼氫互銆屾案涔呯Н鍒嗐€嶇殑韬唤鍙備笌杞崲 鈥斺€?鑰屾垜浠
 * 瀹冪殑浣欓**涓€鏃犳墍鐭?*锛堝彲鑳芥棭灏辩敤灏戒簡锛夛紝缁撴灉鏄姹傝鍙戝埌涓€涓病棰濆害鐨勬笭閬撱€?
 * 鈬?鏈帴鍏?= `UNUSABLE` = 鍓旈櫎銆?*瀹佸彲灏戜竴涓€欓€夛紝涓嶅彲鎶婃湭鐭ュ綋鍙敤銆?*
 *
 * ## 涓轰粈涔堝彧鎺€屼竴涓唬琛ㄨ处鍙枫€?
 *
 * 娓犻亾**鍐呴儴**鐨勬崲鍙风敱鍚勯€傞厤鍣ㄦ瘡娆¤姹傜幇鍋氾紙buddy/loomy 璧颁綑棰濋€夊彿鍣紝鍏朵綑璧?
 * `getAvailableAccount` + 429 鎹㈠彿锛夈€傛湰灞傚彧鍥炵瓟銆岃繖涓笭閬撶幇鍦ㄨ兘涓嶈兘鐢ㄣ€佸畠鐨?
 * 涓存湡棰濆害澶ф浠€涔堟椂鍊欎綔搴熴€嶏紝涓嶆浛瀹冧滑閫夎处鍙枫€?
 *
 * ## 鈿狅笍 鍙栦唬琛ㄨ处鍙锋椂蹇呴』甯?*鐪熷疄 modelId**
 *
 * `getAvailableAccount` 瀵圭┖ `modelId` 浼?*璺宠繃闄愭祦杩囨护**锛坄account-pool.ts`锛夛紝
 * 浜庢槸鍙栧洖鐨勬槸銆屾墜鍔ㄥ簭绗竴涓惎鐢ㄨ处鍙枫€嶁€斺€?*鍝€曞畠姝ゅ埢姝ｅ湪闄愭祦**銆傚悗鏋滄槸澶氳处鍙?
 * 姹犻噷涓存湡棰濆害琚畬鍏ㄥ拷鐣ャ€傛晠杩欓噷鍏堝彇涓€涓湡瀹炴ā鍨?id 鍐嶅彇鍙枫€?
 *
 * 鈿狅笍 `AbortError` **涓嶅緱**鎶樼畻鎴?`UNUSABLE`锛氱敤鎴峰彇娑堣姹傛椂鐪嬪埌銆岃鍏堢櫥褰曘€?
 * 鏄瀵硷紙鐪熷疄缂洪櫡锛孭R !69 瀹¤瀹炴祴锛夈€?
 */

/**
 * **宸叉帴鍏ヤ复鏈熸姌绠?*鐨勬笭閬?id锛坄createExpiryProbe` 鐨?`switch` 瑕嗙洊鐨勯偅鍑犲锛夈€?
 *
 * ## 鈿狅笍 涓轰粈涔堝繀椤诲鍑猴紙瀹¤杞浜屽疄娴嬭瘉浼殑缂洪櫡锛?
 *
 * 鑱氬悎灞傜殑鐩綍浼?*骞垮憡**鍑烘墍鏈夎兘鎺ㄥ鍑鸿鑼冨悕鐨勮櫄鎷熸ā鍨?鈥斺€?鍖呮嫭**鍊欓€夊叏鏉ヨ嚜
 * 鏈帴鍏ユ笭閬?*鐨勯偅浜涖€備絾閭ｄ簺鍊欓€変竴寰嬭鎶樼畻鎴?`UNUSABLE`锛堟纭紝瑙佷笂鏂规敞閲婏級锛?
 * 浜庢槸鐢ㄦ埛閫変腑瀹冩嬁鍒扮殑鏄細
 *
 * ```
 * MISSING_CREDENTIAL | 銆寈xx銆嶅綋鍓嶆病鏈変换浣曞彲鐢ㄥ€欓€夛紙娓犻亾琚叧闂€佹ā鍨嬭鍏炽€?
 *                      鎴栨墍鏈夋笭閬撻兘鏃犲彲鐢ㄨ处鍙凤級
 * ```
 *
 * 鈬?鎶娿€?*璇ユ笭閬撶殑涓存湡鎶樼畻灏氭湭瀹炵幇**銆嶈皫鎶ユ垚銆?*浣犳病鐧诲綍 / 娓犻亾琚叧**銆嶁€斺€?
 * 姝ｆ槸鏈粨搴撳弽澶嶄慨鐨勯偅绫昏瀵兼€ф姤閿欍€傚疄娴嬶紙鎺㈤拡锛夛細鍙帴 `cline`锛堟湭鎺ュ叆锛夋椂
 * `listModels('aggregate')` 浠嶈繑鍥?`['auto','deepseek-v4-1-flash','muse-spark-1-3']`銆?
 *
 * 鈬?鑱氬悎鐩綍鍙挱鎶ャ€?*鑷冲皯鏈変竴涓凡鎺ュ叆鍊欓€?*銆嶇殑铏氭嫙妯″瀷锛沗auto` 涓嶅彈褰卞搷
 *锛堝畠鐨勬睜璺ㄥ叏閮ㄦ笭閬擄紝浠讳竴宸叉帴鍏ユ笭閬撴湁璐﹀彿灏辫兘璺敱锛夈€?
 *
 * 鈿狅笍 **鏈竻鍗曞繀椤讳笌涓嬫柟 `switch` 鐨勫垎鏀繚鎸佷竴鑷?* 鈥斺€?鏈変笓闂ㄧ敤渚嬮攣瀹冧滑鐩哥瓑
 *锛坄aggregate-expiry.spec.ts` 鐨勩€屾竻鍗曚笌 switch 涓€鑷淬€嶆潯锛夛紝鏂板娓犻亾鏃朵袱澶勯兘瑕佹敼銆?
 */
export const WIRED_EXPIRY_PROVIDERS: readonly string[] = Object.freeze([
  'buddy',
  'workbuddy',
  'loomy',
  'codearts',
  'zcode',
  // 鈿狅笍 鐢ㄦ埛 2026-10-07 璐ㄧ枒鍚庢牳瀹炲姞鍏ワ紙姝ゅ墠琚?`auto-adapter.ts` 涓€鍙?*涓嶆垚绔?*鐨?
  //    鐞嗙敱鎺掗櫎锛氥€屽叾浣?provider 娌℃湁璺ㄨ处鍙风殑鍒版湡浣欓鎺㈡祴绔偣銆嶏級锛?
  //    瀹炴祴杩欎袱瀹剁殑 `CreditPackage` 涓?buddy **鍚屽舰**锛岄兘鏈?`deductionEndTime`銆?
  'lobsterai',
  'trae',
])
/**
 * 涓存湡鎶樼畻缁撴灉鐨?*缂撳瓨鏃堕暱**锛堟绉掞級銆傜敤鎴?2026-10-07 瑕佹眰鍔犵紦瀛橈紝TTL 鐢辩敤鎴峰湪
 * 60 / 90 / 120 涓€夊畾 鈥斺€?**鍙?60**銆?
 *
 * ## 涓轰粈涔堟槸 60
 *
 * - 涓庢棦鏈夌殑 {@link BUDDY_BALANCE_CACHE_TTL_MS}锛堜綑棰濋€夊彿鍣紝`60_000`锛?*鍚屽€?* 鈥斺€?
 *   涓ゅ鑺傚涓€鑷达紝涓嶄細鍑虹幇銆岄€夊彿鐢?30 绉掑墠鐨勬暟鎹€佹帓搴忕敤 90 绉掑墠鐨勩€嶈繖绉嶅垎鍙夛紱
 * - 涓存湡鍒ゆ嵁鐨勬渶灏忕矑搴︽槸**澶?*锛堣祫婧愬寘鍒版湡浠ュぉ璁★級鈬?60 绉掓粸鍚庡湪璇箟涓婃棤瀹筹紱
 * - 鏈€鐭?鈬?鐢ㄦ埛鏀瑰畬娓犻亾渚ч厤缃悗鏈€鍧忕瓑寰呮渶鐭€?0/120 鍙渷鏋佸皯閲忚姹?
 *  锛堥潰鏉夸笌鎺掑簭閮戒笉鏄珮棰戣矾寰勶級锛屽嵈璁┿€屽垰鐧诲綍鐨勮处鍙蜂笉鍑虹幇鍦ㄦ帓搴忛噷銆嶇殑绐楀彛鏇撮暱銆?
 */
export const EXPIRY_CACHE_TTL_MS = 60_000

/**
 * `createExpiryProbe` 鐨勮繑鍥炵被鍨嬶細涓存湡鎺㈤拡 **+ 缂撳瓨澶辨晥鍏ュ彛**銆?
 *
 * 鈿狅笍 涓轰粈涔堟槸**浜ゅ弶绫诲瀷**鑰屼笉鏄敼 `ExpiryProbe` 鏈韩锛氶偅涓被鍨嬪畾涔夊湪
 * `aggregate-core.ts`锛堝繀椤绘槸**闆?import** 鐨勭函閫昏緫搴曞骇锛夛紝鑰屽畠鍙弿杩般€岀粰瀹氭笭閬?
 * 杩斿洖鏈€鏃╁け鏁堟椂鍒汇€嶈繖涓€浠朵簨銆傜紦瀛樻槸**瀹炵幇缁嗚妭**锛屼笉璇ユ笚杩涘簳搴х被鍨嬨€?
 *
 * 鈿狅笍 涓轰粈涔堣鏆撮湶 `clear`锛氳 `createExpiryProbe` 杩斿洖澶勪笌 `src/index.ts`
 * 瑁呴厤澶勭殑闀挎敞閲?鈥斺€?缂撳瓨鍘熷厛**娌℃湁浠讳綍澶辨晥閫氶亾**锛屽鑷村垰鐧诲綍鐨勮处鍙?
 * 鏈€闀?60 绉掑璺敱涓嶅彲瑙侊紙鐢ㄦ埛鎷垮埌璇鎬х殑銆屾病鏈変换浣曞彲鐢ㄥ€欓€夈€嶏級銆?
 */
export type ExpiryProbeWithCache = ExpiryProbe & {
  clear: () => void
  /**
   * zcode 涓撳睘锛氥€岃娓犻亾浣欓鑳戒拱鍝簺妯″瀷銆嶇殑鍏ㄨ处鍙峰苟闆嗭紙鍏跺畠娓犻亾鎭?`undefined`
   * = 鏃犳ā鍨嬬粦瀹氱害鏉燂級銆傛煡璇㈠け璐ヤ篃杩斿洖 `undefined`锛堣皟鐢ㄦ柟涓嶆敹绐勫€欓€夛級銆?
   */
  quotaModels: (signal?: AbortSignal) => Promise<readonly string[] | undefined>
}

/** `createExpiryProbe` 鐨勫彲閫変緷璧栵紙鍗曟祴娉ㄥ叆鏃堕挓鐢級銆?*/export interface ExpiryProbeOptions {
  /** 褰撳墠鏃跺埢锛堟绉掞級锛涢粯璁?`Date.now`銆?*/
  now?: () => number
  /** 缂撳瓨鏃堕暱锛堟绉掞級锛涢粯璁?{@link EXPIRY_CACHE_TTL_MS}銆?*/
  ttlMs?: number
}

export function createExpiryProbe(
  pool: AccountPool,
  firstModelIdOf: (provider: string) => Promise<string | undefined>,
  options: ExpiryProbeOptions = {},
): ExpiryProbeWithCache {
  /**
   * 鎸夋笭閬撶紦瀛樻姌绠楃粨鏋滐紙鐢ㄦ埛瑕佹眰锛氭帓搴忚缂撳瓨锛屼笉姣忔鎵撴湇鍔″櫒锛夈€?
   *
   * ## 鈿狅笍 涓轰粈涔堢紦瀛樺繀椤诲湪**杩欎釜宸ュ巶鍐呴儴**锛堣€屼笉鏄悇璋冪敤鏂硅嚜宸卞姞锛?
   *
   * `auto-adapter.ts` 鐨?`expiryOf` **姣忔璋冪敤閮芥柊寤轰竴涓?probe**
   *锛坄createExpiryProbe(pool, 鈥?`锛夛紝鑱氬悎灞備篃鐢ㄥ悓涓€涓伐鍘?鈬?鑻ョ紦瀛樻斁鍦ㄨ皟鐢ㄦ柟锛?
   * `auto` 涓庤仛鍚堜細**鍚勬煡涓€閬?*锛屼笖 `auto` 閭ｆ潯璺緞姣忔閮戒粠闆跺紑濮嬶紙绛変簬娌＄紦瀛橈級銆?
   * 鏀惧湪宸ュ巶鍐呴儴鍚庯紝**鍚屼竴瑁呴厤鏈熷唴鐨勬墍鏈夎皟鐢ㄥ叡浜竴浠?* 鈥斺€?
   * `src/index.ts` 閲屼袱涓€傞厤鍣ㄧ敤鐨勬槸**鍚屼竴涓?* probe 瀹炰緥锛堣閭ｉ噷鐨勮閰嶆敞閲婏級銆?
   *
   * 鈿狅笍 缂撳瓨閿槸**娓犻亾 id**锛堜笉鏄ā鍨嬶級锛氫复鏈熼搴︽槸璐﹀彿绾х殑锛屼笌妯″瀷鏃犲叧
   *锛坄buddyExpiry` 绛夊彧璇昏处鍙风殑璧勬簮鍖咃級銆備笉鍚屾笭閬撳繀椤诲悇鑷紦瀛樸€?
   *
   * 鈿狅笍 **涓涓嶅啓缂撳瓨**锛堣涓嬫柟 `catch`锛夛細涓€娆″彇娑堣嫢鐣欎笅鏉＄洰锛屽悗缁姹備細璇懡涓?
   * 涓€涓€屼笂娆¤鍙栨秷銆嶇殑缁撴灉銆?
   */
  const cache = new Map<string, { at: number; value: number }>()
  /** zcode銆屼綑棰?鈫?妯″瀷闆嗗悎銆嶇殑缂撳瓨锛堥敭鎭掍负 `'zcode'`锛涗笌鎶樼畻缂撳瓨鍚?TTL銆佸悓浠ｉ檯锛夈€?*/
  const quotaCache = new Map<string, { at: number; value: readonly string[] }>()
  const now = () => options.now?.() ?? Date.now()
  const ttl = options.ttlMs ?? EXPIRY_CACHE_TTL_MS
  /**
   * 鍐欑紦瀛樺苟杩斿洖璇ュ€笺€?
   *
   * 鈿狅笍 **`UNUSABLE` 涔熺紦瀛?*锛堜笉鏄彧缂撳瓨鎴愬姛鍊硷級锛氫竴涓笭閬撱€岀幇鍦ㄦ病鏈夊彲鐢ㄨ处鍙枫€?
   * 鍦?60 绉掑唴涓嶄細鍙橈紝涓嶇紦瀛樹細璁╅潰鏉夸笌鎺掑簭鍦ㄦ瘡娆″埛鏂版椂閮戒负瀹冪櫧璺戜竴閬?
   *锛堝彇鍙?+ 鐩綍璇诲彇锛夈€備笌 `buddy-balance-selector` 鐨勫け璐ョ煭 TTL 鍙栬垗**涓嶅悓** 鈥斺€?
   * 閭ｉ噷澶辫触浼氳鍒ゃ€岄搴︾敤灏姐€嶏紙鏈夎瀵兼€у悗鏋滐級鏁呯敤 5 绉掞紱杩欓噷 `UNUSABLE` 鍙槸
   * 銆屾湰杞墧闄よ鍊欓€夈€嶏紝60 绉掔殑婊炲悗鏃犲銆?
   *
   * 鈿狅笍 浣?*涓涓嶅啓缂撳瓨** 鈥斺€?閭ｇ敱璋冪敤鐐逛繚璇侊紙`AbortError` 浼?throw锛岃蛋涓嶅埌杩欓噷锛夈€?
   */
  /**
   * 缂撳瓨**浠ｉ檯**锛歚clear()` 閫掑瀹冦€?
   *
   * ## 鈿狅笍 涓轰粈涔堥渶瑕侊紙鐪熷疄缂洪櫡锛屽鎶楀璁″疄娴嬭瘉浼級
   *
   * `cacheAndReturn` 鍦ㄦ帰娴?*缁撴潫鏃?*鍐欑紦瀛樸€傝嫢涓€涓帰娴?*鏃╁湪 `clear()` 涔嬪墠**
   * 灏卞凡寮€濮嬶紙姝ｅ崱鍦ㄦ煇涓?`await` 涓婏級锛屽畠鐨勫啓鍥炲彂鐢熷湪 `clear()` **涔嬪悗**
   * 鈬?**闄堟棫鍊兼椿杩囨暣涓?TTL** 鈥斺€?鐢ㄦ埛銆屾竻缂撳瓨銆嶇殑鍔姏琚竴涓湪閫旇姹備綔搴熴€?
   *
   * 瀹炴祴锛歚clear() 鏈熼棿鍦ㄩ€旀帰娴?鈬?-1 锝?clear 鍚庡啀鎺?鈬?-1 锝?鍙栧彿娆℃暟 = 1`
   * 鈬?鐧诲綍鍚庢竻缂撳瓨锛屼絾閭ｄ釜銆岀櫥褰曞墠寮€濮嬨€佺櫥褰曞悗鎵嶇粨鏉熴€嶇殑鎺㈡祴鎶?`-1`锛堜笉鍙敤锛?
   * 鍙堝啓浜嗗洖鍘伙紝鐢ㄦ埛浠嶈鍐嶇瓑 60 绉掞紙姝ｆ槸鏈慨澶嶈娑堢伃鐨勯偅涓幇璞★級銆?
   *
   * 鈬?鎺㈡祴鍦?*寮€濮嬫椂**璁颁笅浠ｉ檯锛屽啓鍥炴椂浠ｉ檯涓嶇灏?*涓㈠純**锛堜笉鍐欑紦瀛橈級銆?
   */
  let generation = 0
  /**
   * 鍐欑紦瀛樺苟杩斿洖銆?
   *
   * 鈿狅笍 **涓涓嶅啓缂撳瓨** 鈥斺€?閭ｇ敱璋冪敤鐐逛繚璇侊紙`AbortError` 浼?throw锛岃蛋涓嶅埌杩欓噷锛夈€?
   *
   * @param startedAt - 鏈鎺㈡祴**寮€濮嬫椂**鐨勪唬闄咃紙`clear()` 浼氳瀹冭繃鏈燂級
   */
  const cacheAndReturn = (forProvider: string, value: number, startedAt: number): number => {
    // 鈿狅笍 浠ｉ檯涓嶇 鈬?杩欐槸涓€娆°€岃法瓒婁簡 clear() 鐨勫湪閫旀帰娴嬨€嶁噿 **涓㈠純**锛屼笉鍐欑紦瀛?
    //   锛堝惁鍒欓檲鏃у€间細娲昏繃鏁翠釜 TTL锛岃 clear() 褰㈠悓铏氳锛夈€?
    if (startedAt === generation) cache.set(forProvider, { at: now(), value })
    return value
  }
  /**
   * zcode 涓撳睘锛?*璇ユ笭閬撶殑浣欓鑳戒拱鍝簺妯″瀷**锛坄zcodeQuotaModelIds` 鐨勫叏璐﹀彿
   * 骞堕泦锛屽甫涓庢姌绠楀悓娆剧殑 60 绉掔紦瀛樹笌浠ｉ檯澶辨晥锛夈€傚叾瀹冩笭閬撹繑鍥?`undefined`
   *锛? 鏃犳ā鍨嬬粦瀹氱害鏉燂紝璋冪敤鏂逛笉鏀剁獎鍊欓€夛級銆?
   *
   * 鈿狅笍 涓轰粈涔堟斁鍦ㄦ帰閽堜笂鑰屼笉鏄璋冪敤鏂硅嚜宸辨煡锛氫綑棰濇煡璇㈡槸**缃戠粶璇锋眰**锛岃仛鍚堝眰
   * 姣忔 `candidatesFor` 閮戒細缁忚繃杩欓噷 鈥斺€?涓嶅叡浜紦瀛樺氨浼氭瘡娆￠噸鎵撲笂娓革紙涓庢姌绠?
   * 缂撳瓨鏀惧伐鍘傚唴閮ㄧ殑鍚屼竴鐞嗙敱锛夈€?
   */
  const quotaModels = async (signal?: AbortSignal): Promise<readonly string[] | undefined> => {
    signal?.throwIfAborted()
    const cached = quotaCache.get('zcode')
    if (cached !== undefined && now() - cached.at < ttl) return cached.value
    const startedAt = generation
    let credentials: unknown[]
    try {
      const probeModel = await firstModelIdOf('zcode') ?? ''
      credentials = typeof pool.listAvailableCredentials === 'function'
        ? (await pool.listAvailableCredentials('zcode', probeModel)).map((item) => item.credential)
        : await legacySingleCredential(pool, 'zcode', probeModel)
    } catch (error) {
      signal?.throwIfAborted()
      if (isAbortError(error)) throw error
      return undefined
    }
    if (credentials.length === 0) return undefined
    signal?.throwIfAborted()
    // 澶氳处鍙峰彇骞堕泦锛氫换涓€璐﹀彿鐨勪綑棰濊兘涔扮殑妯″瀷閮界畻鏁帮紙涓庛€屾帰鍏ㄩ儴璐﹀彿銆佸彇鏈€鏃┿€?
    // 鐨勬姌绠楀彛寰勫悓鍚?鈥斺€?璐﹀彿绾у樊寮備笉璇ヨ鍊欓€夎璇墧锛夈€?
    const union = new Set<string>()
    for (const credential of credentials) {
      signal?.throwIfAborted()
      let ids
      try {
        ids = await zcodeQuotaModelIds(credential as ZcodeCredential)
      } catch (error) {
        signal?.throwIfAborted()
        if (isAbortError(error)) throw error
        continue
      }
      // 鈿狅笍 浠讳竴璐﹀彿銆屾煡涓嶅埌銆嶏紙undefined锛夆噿 鏁翠綋鎸夈€屼笉鐭ラ亾銆嶅鐞嗭細杩斿洖 undefined
      //   涓?*涓嶅啓缂撳瓨** 鈥斺€?璋冪敤鏂逛笉鏀剁獎锛堝畞鍙皯绛涳紝涓嶅彲璇墧锛夈€?
      if (ids === undefined) return undefined
      for (const id of ids) union.add(id)
    }
    if (union.size === 0) return undefined
    const value: readonly string[] = Object.freeze([...union])
    if (startedAt === generation) quotaCache.set('zcode', { at: now(), value })
    return value
  }
  return Object.assign(
    async (provider: string, signal?: AbortSignal) => {
    // 鈿狅笍 **缂撳瓨鍛戒腑涔熻鍏堟煡 signal**锛氫腑姝㈠繀椤荤珛鍒讳互 `AbortError` 缁撴潫锛?
    //    涓嶈兘鍥犱负銆屽弽姝ｆ湁缂撳瓨銆嶅氨鎶婂彇娑堝悶鎺夛紙涓庝笅鏂圭煭璺悓涓€鍙ｅ緞锛夈€?
    signal?.throwIfAborted()
    const cached = cache.get(provider)
    if (cached !== undefined && now() - cached.at < ttl) return cached.value

    // 鈿狅笍 **鏈帴鍏ョ殑娓犻亾鐩存帴杩斿洖 `UNUSABLE`锛屼笉鍙栧彿銆佷笉璇荤洰褰?*锛堢 3 杞璁″疄娴嬶級銆?
    //
    // 涓轰粈涔堣鍦ㄦ渶鍓嶉潰鐭矾锛氭湰鍑芥暟瀵?*鏈帴鍏?*娓犻亾鏈€缁堜篃杩斿洖 `UNUSABLE`锛堣蛋涓嬫柟
    // `switch` 鐨?`default`锛夛紝浣嗛偅鏃?*宸茬粡**鍋氫簡涓や欢鏃犳剰涔夌殑浜嬶細
    //   鈶?`await firstModelIdOf(provider)` 鈥斺€?涓€娆℃笭閬撶洰褰曡鍙栵紱
    //   鈶?`await pool.getAvailableAccount(...)` 鈥斺€?涓€娆¤处鍙锋睜鏌ヨ銆?
    // 鑰?`candidatesFor` 鐨勬睜鍖呭惈**鍏ㄩ儴**娓犻亾鐨勫€欓€?鈬?姣忔 `auto` 璇锋眰閮戒細涓?*姣忎釜**
    // 鏈帴鍏ユ笭閬撶櫧鍋氳繖涓や欢浜嬶紙瀹炴祴鎺㈤拡锛歚getAvailableAccount` 琚互 `cline/m1` 璋冪敤锛夈€?
    //
    // 鈿狅笍 涓や欢閮?*涓嶆槸缃戠粶璇锋眰**锛坄getAvailableAccount` 鏄函鏈湴鍐呭瓨杩囨护锛夛紝鏁呰繖灞?
    // **鎬ц兘娴垂**鑰岄潪鍔熻兘缂洪櫡锛涗絾鐭矾鏄浂鎴愭湰鐨勶紝涓旇璇箟鏇村噯纭?鈥斺€?
    // 銆屾湭鎺ュ叆銆嶄笌銆屾湁璐﹀彿浣嗘姌绠椾笉浜嗐€嶆槸涓や欢浜嬶紝涓嶈璧板悓涓€鏉¤矾寰勩€?
    //
    // 鈿狅笍 `signal` 浠嶈鍏堟煡锛氫腑姝㈠繀椤?*绔嬪埢**浠?`AbortError` 缁撴潫锛堝叏灞€绾︽潫锛夛紝
    //    涓嶈兘鍥犱负銆岃繖涓笭閬撳弽姝ｆ湭鎺ュ叆銆嶅氨鎶婁腑姝㈠悶鎺夈€?
    signal?.throwIfAborted()
    if (!WIRED_EXPIRY_PROVIDERS.includes(provider)) return UNUSABLE
    // 鈿狅笍 璁颁笅**鏈鎺㈡祴寮€濮嬫椂**鐨勪唬闄咃細鑻ヤ腑閫旀湁 `clear()`锛堢敤鎴峰垰鐧诲綍锛夛紝
    //    鍐欏洖鏃朵細琚涪寮冿紙鍚﹀垯闄堟棫鍊兼椿杩囨暣涓?TTL 鈥斺€?瑙?`cacheAndReturn` 鐨勯暱娉ㄩ噴锛夈€?
    const startedAt = generation

    // 鈿狅笍 绫诲瀷鏄?`unknown[]`锛堝悇娓犻亾鍑嵁褰㈢姸涓嶅悓锛岀敱 `credentialExpiry` 鍒嗘淳鏃舵敹绐勶級銆?
    let credentials: unknown[]
    try {
      // 鈿狅笍 `?? ''` 鏄?*鏈夋剰鐨?*闄嶇骇锛堟敞閲婇殢鎼Щ涓㈠け锛孴ask 7 澶嶅 M3 鎸囧嚭锛岀幇琛ュ洖锛夛細
      // 鐩綍涓嶅彲璇?/ 鏃犲彲鐢ㄦā鍨嬫椂閫€鍥炵┖涓?鈥斺€?姝ゆ椂銆屾湁娌℃湁璐﹀彿銆嶈繖涓垽鎹?*浠嶇劧鎴愮珛**锛?
      // 鍙槸**闄愭祦缁村害閫€鍖栦负涓嶅弬涓?*锛坄getAvailableAccount` 瀵圭┖ modelId 璺宠繃闄愭祦
      // 杩囨护锛夈€傚彇鑸嶆柟鍚戯細瀹佸彲灏戠瓫涓€灞傦紝涔熶笉鍙妸鏁存睜鍒ゆ垚涓嶅彲鐢ㄣ€?
      // 鈿狅笍 鍙嶄箣**涓嶈**鍦ㄨ繖閲屽洜涓烘嬁涓嶅埌 modelId 灏?return UNUSABLE 鈥斺€?閭ｄ細璁?
      // 銆岀洰褰曟殏鏃惰涓嶅埌銆嶈璇姤鎴愩€岃繖涓笭閬撴病璐﹀彿銆嶃€?
      const probeModel = await firstModelIdOf(provider) ?? ''
      // 鈿狅笍鈿狅笍 **鍙栧叏閮ㄥ惎鐢ㄨ处鍙凤紝鑰屼笉鏄竴涓唬琛ㄨ处鍙?*锛堢湡瀹炵己闄凤紝鐢ㄦ埛鎶ラ殰 2026-10-07锛夈€?
      //
      // 鐢ㄦ埛璐ㄧ枒锛氥€寃orkbuddy 涓竴涓彿鏄?1 澶╁埌鏈燂紝涓轰粈涔堟垜浠粺璁℃槸 2000 澶氬ぉ锛?
      // **鍙敤浜嗙涓€涓处鍙峰悧**锛熴€嶁€斺€?浠栫寽瀵逛簡銆傛棫瀹炵幇璧?`getAvailableAccount`锛?
      // 閭ｄ釜鏂规硶鍙繑鍥?*鎵嬪姩搴忕涓€涓?*鍙敤璐﹀彿 鈬?鐢ㄦ埛鎶娿€? 澶╁埌鏈熴€嶇殑鍙锋嫋鍒板悗闈㈡椂锛?
      // 瀹冪殑涓存湡棰濆害鍦?*鎺掑簭**閲岃瀹屽叏蹇界暐锛氳繖涓笭閬撴槑鏄庢湁涓€涓揩浣滃簾鐨勫彿锛?
      // 鍗磋鎸夈€?000 澶氬ぉ鍚庢墠浣滃簾銆嶆帓鍒版渶鍚庛€?
      //
      // 鈬?鏀逛负鍙?*鍏ㄩ儴**璐﹀彿锛岄€愪釜鎶樼畻锛屽彇**鏈€鏃?*鐨勯偅涓紙瑙佷笅鏂?`earliest`锛夈€?
      //   鈿狅笍 杩欎笉鏀瑰彉銆屽疄闄呭彂璇锋眰鐢ㄥ摢涓处鍙枫€嶏紙閭ｄ粛鐢遍€傞厤鍣ㄦ寜鎵嬪姩椤哄簭閫夛級锛?
      //   鍙敼鍙樸€岃繖涓笭閬撴暣浣撶殑涓存湡棰濆害浣曟椂浣滃簾銆嶈繖涓?*瑙傛祴**鍙ｅ緞銆?
      //
      // 鈿狅笍 **`listAvailableCredentials` 鏄彲閫夋柟娉?*锛堢粨鏋勫寲绫诲瀷锛夛細瀹冧笉瀛樺湪鏃跺洖閫€鍒?
      //    `getAvailableAccount`锛堝彧鎺竴涓唬琛ㄨ处鍙凤級銆傚洖閫€涓嶆槸涓轰簡鍏煎鑰佽閰?鈥斺€?
      //    鐪熷疄瑁呴厤锛坄src/index.ts`锛夋案杩滀紶瀹屾暣鐨?`AccountPool`锛涘洖閫€鏄负浜嗚
      //    **鏃㈡湁娴嬭瘯妗?*锛堝彧瀹炵幇 `getAvailableAccount`锛変粛鐒跺彲鐢紝灏ゅ叾鏄?
      //    `auto-adapter.spec.ts` 鈥斺€?閭ｄ唤 spec 鏄?*纭害鏉燂細蹇呴』闆舵敼鍔ㄤ笖鍏ㄧ豢**
      //   锛堝畠鏄袱澶勩€屾惉绉昏€岄潪澶嶅埗銆嶉噸鏋勭殑瀹夊叏缃戯級銆?
      //    鈿狅笍 鍥為€€璺緞鐨勮涔夋槸**闄嶇骇**锛堝皯鐪嬪嚑涓处鍙凤級锛屼笉鏄敊璇€?
      credentials = typeof pool.listAvailableCredentials === 'function'
        ? (await pool.listAvailableCredentials(provider, probeModel)).map((item) => item.credential)
        : await legacySingleCredential(pool, provider, probeModel)
    } catch (error) {
      // 鈿狅笍鈿狅笍 **涓涓嶅緱琚悶鎴?`UNUSABLE`**锛圙lobal Constraints 鐨勭‖瑕佹眰锛夈€?
      //
      // 涓轰粈涔堥渶瑕佽繖涓よ锛氭湰 `try` 閲屾湁涓や釜鍙兘鎶涢敊鐨勮皟鐢?鈥斺€?`firstModelIdOf`
      // 锛堣閰嶅眰娉ㄥ叆锛屼細璇绘笭閬撶洰褰曪級涓庤处鍙锋睜鏌ヨ銆備换涓€鍦?*鎺㈡祴閫斾腑琚彇娑?*鏃舵姏鍑虹殑
      // `AbortError` 鑻ヨ鐩存帴鎶樼畻鎴?`UNUSABLE`锛岀敤鎴峰彇娑堣姹傚悗鐪嬪埌鐨勬槸
      // 銆屾病鏈変换浣曞彲鐢ㄥ€欓€夈€嶈€屼笉鏄腑姝紙璇鎬ф姤閿欙級锛屼笖涓庛€岀湡鐨勬病鐧诲綍銆嶆棤娉曞尯鍒嗐€?
      // 涓庢湰浠撳簱鏃㈡湁鍙ｅ緞鐩稿弽锛歚aggregate-core.ts` 鐨勫摠鍏垫敞閲?
      //銆宎bort **绔嬪埢鎶?`AbortError`**锛岀粷涓嶆姌绠楁垚 `UNUSABLE`銆嶃€?
      //
      // 鈿狅笍 涓よ閮借锛岃鐩栦袱绉嶆儏褰紙Task 7 澶嶅 M1/M2 璁㈡锛夛細
      // - `throwIfAborted()` 瑕嗙洊銆宻ignal **宸茶鏍囪**銆嶁€斺€?*杩欐槸褰撳墠鐢熶骇瑁呴厤涓?
      //   瀹為檯鐢熸晥鐨勯偅鏉?*锛?
      // - `isAbortError(error)` 瑕嗙洊銆宻ignal 鏈繀鏍囪銆佷絾鎶涘嚭鐨勫氨鏄?AbortError銆嶃€?
      //   鈿狅笍 瀹炴祴锛圱ask 7 澶嶅 M2锛夛細褰撳墠瑁呴厤鐨?`firstModelIdOf` 鏄?
      //   `ctx.llm.listModels(provider)`锛岃€?**`LlmRuntime.listModels` 鍙帴鍙?
      //   provider 涓€涓弬鏁般€佹病鏈?signal 閫氶亾**锛坄dsh-llm/lib/index.js:1471`锛?
      //   鈬?杩欎竴鏉″湪褰撳墠瑁呴厤涓嬩笉鍙揪锛屾槸**闃插尽鎬?*鐨勶紙瑁呴厤灞傝嫢鏀规垚浼氬搷搴?signal
      //   鐨勫彇鍙锋柟寮忥紝瀹冨氨鐢熸晥锛夈€?
      signal?.throwIfAborted()
      if (isAbortError(error)) throw error
      return UNUSABLE
    }
    // 鈿狅笍 涓€涓彲鐢ㄨ处鍙烽兘娌℃湁 鈬?UNUSABLE锛堛€岃繖涓笭閬撶幇鍦ㄤ笉鑳界敤銆嶏級銆?
    //    娉ㄦ剰涓庛€岃处鍙峰彲鐢ㄤ絾璇讳笉鍒板埌鏈熸椂闂淬€嶄弗鏍煎尯鍒?鈥斺€?鍚庤€呯敱鍚?`*Expiry` 杩斿洖
    //    `NEVER`锛堝彲鐢ㄣ€佸彧鏄笉涓存湡锛夛紝缁濅笉鑳藉湪杩欓噷涓€骞跺垽鎴愪笉鍙敤銆?
    if (credentials.length === 0) return cacheAndReturn(provider, UNUSABLE, startedAt)
    // 鈿狅笍 閫愪釜璐﹀彿鎶樼畻锛屽彇**鏈€鏃?*鐨勫埌鏈熸椂鍒伙紙鐢ㄦ埛閫夊畾锛氭帰鍏ㄩ儴璐﹀彿銆佸彇鏈€鏃╋級銆?
    //    浠讳竴涓处鍙锋姌绠楀け璐ヤ笉褰卞搷鍏朵綑锛堣烦杩囧畠锛夆€斺€?涓€涓潖璐﹀彿涓嶈璁╂暣涓笭閬撹鍓旈櫎銆?
    let earliest = NEVER
    // 鈿狅笍鈿狅笍 **蹇呴』璁板綍銆屾槸鍚︽湁浠讳綍涓€涓处鍙锋姌绠楁垚鍔熴€?*锛堢湡瀹炵己闄凤紝鐙珛瀹¤瀹炴祴璇佷吉锛夈€?
    //
    // 鏃у疄鐜板彧鐪?`earliest` 鐨勭粓鍊硷細鑻?*鎵€鏈?*璐﹀彿閮芥姌绠楀け璐ワ紙姣忎釜閮?`continue`锛夛紝
    // `earliest` 浠嶆槸鍒濆€?`NEVER` 鈬?璇ユ笭閬撹鍒ゃ€?*鍙敤**銆佸彧鏄笉涓存湡銆嶁噿 **杩涘叆鎺掑簭
    // 涓斿彲褰撻€?*锛坄rankCandidates` 鍙墧闄?`UNUSABLE`锛夈€?
    //
    // 鑰屻€屾墍鏈夎处鍙烽兘鏌ヤ笉鍒伴搴︺€? 鎴戜滑瀵硅繖涓笭閬?*涓€鏃犳墍鐭?* 鈬?蹇呴』 `UNUSABLE`锛堝墧闄わ級銆?
    // 杩欎笌鏈ā鍧楀ご鐨勯搧寰?*鐩存帴鐭涚浘**锛氥€屾湭鎺ュ叆 = `UNUSABLE` = 鍓旈櫎銆?*瀹佸彲灏戜竴涓€欓€夛紝
    // 涓嶅彲鎶婃湭鐭ュ綋鍙敤銆?*銆?
    //
    // 瀹炴祴鍦烘櫙锛歜uddy 鏈変袱涓凡鐧诲綍璐﹀彿銆佷笂娓镐綑棰濇帴鍙?5xx锛堟垨 token 鍏ㄨ繃鏈燂級鈬?
    // 鏃у疄鐜拌璇ユ笭閬撹繘鍏ユ帓搴忥紝璇锋眰琚彂鍒颁竴涓搴︽湭鐭ワ紙鍙兘宸茬敤灏斤級鐨勬笭閬撱€?
    // 涓旇閿欒鍊艰繕浼氳缂撳瓨 60 绉掋€?
    let anyConverted = false
    for (const credential of credentials) {
      signal?.throwIfAborted()
      let value
      try {
        value = await credentialExpiry(provider, credential)
      } catch (error) {
        // 涓浠嶅繀椤婚€冮€革紙涓庝笂闈㈢殑 `try` 鍚屼竴鍙ｅ緞锛夈€?
        signal?.throwIfAborted()
        if (isAbortError(error)) throw error
        continue
      }
      if (value === UNUSABLE) continue
      // 鈿狅笍 璧板埌杩欓噷 = 璇ヨ处鍙?*鎶樼畻鎴愬姛**锛堟嬁鍒颁竴涓湡瀹炲埌鏈熸椂鍒绘垨 `NEVER`锛夈€?
      //    涓よ€呴兘绠椼€屾垚鍔熴€嶏細`NEVER` 鐨勮涔夋槸銆屽彲鐢ㄣ€佷絾鏃犱复鏈熼搴︺€嶏紙濡?codearts
      //    鐨勯暱鏈熺Н鍒嗭級锛屽畠鏄?*宸茬煡浜嬪疄**锛屼笌銆屾煡涓嶅埌銆嶄弗鏍间笉鍚屻€?
      anyConverted = true
      if (value < earliest) earliest = value
    }
    // 鈿狅笍 涓€涓兘娌℃垚鍔?鈬?鏈煡 鈬?鍓旈櫎锛堜笉鏄?NEVER锛夈€?
    if (!anyConverted) return cacheAndReturn(provider, UNUSABLE, startedAt)
    return cacheAndReturn(provider, earliest, startedAt)
    },
    /**
     * zcode銆屼綑棰?鈫?妯″瀷闆嗗悎銆嶉€氶亾锛堝疄鐜拌涓婃柟 `quotaModels`锛夈€傛寕鍦ㄥ悓涓€涓?
     * `Object.assign` 涓婏紝涓庢姌绠椾富鍑芥暟銆乣clear` 鍏变韩鍚屼竴浠界紦瀛樹笌浠ｉ檯銆?
     */
    { quotaModels, clear: (): void => { cache.clear(); quotaCache.clear(); generation += 1 } },
  )
}

/**
 * 鍗曡处鍙峰洖閫€锛歚listAvailableCredentials` 涓嶅瓨鍦ㄦ椂鍙彇涓€涓唬琛ㄨ处鍙枫€?
 *
 * 鈿狅笍 杩欐槸**闄嶇骇璺緞**锛堝皯鐪嬪嚑涓处鍙凤級锛屽彧涓鸿鏃㈡湁娴嬭瘯妗╁彲鐢?鈥斺€?瑙佽皟鐢ㄧ偣鐨勯暱娉ㄩ噴銆?
 * 鐪熷疄瑁呴厤锛坄AccountPool`锛夋案杩滄湁 `listAvailableCredentials`銆?
 */
async function legacySingleCredential(
  pool: AccountPool,
  provider: string,
  probeModel: string,
): Promise<unknown[]> {
  const available = await pool.getAvailableAccount(provider, probeModel)
  if (available === null || available === undefined) return []
  return [available.credential]
}

/**
 * 鍗曚釜璐﹀彿鐨勪复鏈熸姌绠楋紙鎸夋笭閬撳垎娲撅級銆?
 *
 * 鈿狅笍 浠?`createExpiryProbe` 閲屾娊鍑烘潵锛屾槸涓轰簡璁┿€屾帰鍏ㄩ儴璐﹀彿銆嶇殑寰幆淇濇寔绠€鍗曪紝
 * 涓?*鍒ゆ嵁浠嶇劧鍙湁涓€澶?*锛堜笉澶嶅埗 switch锛夈€?
 *
 * @returns 姣鏃堕棿鎴筹紙瓒婂皬瓒婃棭浣滃簾锛夛紡`NEVER`锛堥暱鏈燂級锛廯UNUSABLE`锛堟煡涓嶅埌锛?
 */
async function credentialExpiry(provider: string, credential: unknown): Promise<number> {
  switch (provider) {
    case 'buddy':
      return buddyExpiry(CODEBUDDY, credential as BuddyCredential)
    case 'workbuddy':
      return buddyExpiry(WORKBUDDY, credential as BuddyCredential)
    case 'loomy':
      return loomyExpiry(credential as LoomyCredential)
    case 'codearts':
      return codeArtsExpiry(credential as CodeArtsCredential)
    case 'zcode':
      return zcodeExpiry(credential as ZcodeCredential)
    // 鈿狅笍 杩欎袱瀹剁殑鍖呬笌 buddy 鍚屽舰 鈬?璧板叡浜姌绠楋紙鍒ゆ嵁鍙啓涓€浠斤紝閬垮厤鍚屾棌鍒嗗弶锛夈€?
    case 'lobsterai':
      return lobsteraiExpiry(credential as LobsteraiCredential, LOBSTERAI)
    case 'trae':
      return traeExpiry(credential as TraeCredential, TRAE)
    default:
      return UNUSABLE
  }
}

/**
 * 璇ラ敊璇槸鍚︽槸銆岃皟鐢ㄦ柟涓銆嶇被銆?
 *
 * 鈿狅笍 **灏卞湴瀹炵幇锛屼笉浠?`aggregate-adapter.ts` 瀵煎叆**锛氶偅浼氳鏈ā鍧楀弽鍚戜緷璧栦笂灞傜殑
 * 鑱氬悎閫傞厤鍣紝姝ｆ槸鏈换鍔¤閬垮厤鐨勫眰娆￠鍊掞紙瑙佹ā鍧楀ご锛夈€傚垽鎹笌 `aggregate-adapter.ts`
 * 鐨?`isAbortLike` 涓€鑷达紝鍙彇銆岄敊璇嚜韬惡甯?AbortError 鏍囪銆嶈繖涓€鏉?鈥斺€?
 * `signal` 渚х殑鎯呭舰鐢辫皟鐢ㄧ偣鐨?`signal?.throwIfAborted()` 瑕嗙洊銆?
 */
function isAbortError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  return (error as { name?: unknown }).name === 'AbortError'
}

/** buddy 绯伙細鏈夋晥璧勬簮鍖?`deductionEndTime` 鐨勬渶灏忓€硷紱鏃犳湁鏁堝寘 鈫?NEVER銆?*/
export async function buddyExpiry(
  product: typeof CODEBUDDY,
  credential: BuddyCredential,
): Promise<number> {
  return sharedPackageExpiry(() => fetchCreditBalance(credential, product))
}

/**
 * **鍏变韩鐨勩€屾湁鏁堣祫婧愬寘鏈€鏃╁埌鏈熴€嶆姌绠?*锛坆uddy / workbuddy / lobsterai / trae 鍚屽舰锛夈€?
 *
 * ## 鈿狅笍 涓轰粈涔堝繀椤诲叡浜€屼笉鏄悇鍐欎竴浠斤紙AGENTS.md 鐨勩€屽悓鏃忓垽鎹繀椤婚€愭牸鍚屾瀯銆嶏級
 *
 * 杩欏洓瀹剁殑 `CreditPackage` **缁撴瀯鐩稿悓**锛堥兘鏈?`active` / `remaining` /
 * `deductionEndTime`锛夛紝宸埆鍙湪**鎬庝箞鍙栧埌閭ｄ釜 `CreditBalance`**锛堝悇鑷殑绔偣涓庡嚟鎹級銆?
 * 鍚勫啓涓€浠界殑璇濓紝浠讳綍涓€渚ф敹绐勶紙濡傘€屽彧绠?`active` 涓?`remaining > 0` 鐨勫寘銆嶏級閮戒細
 * 鍦ㄥ彟涓€渚?*闈欓粯鍒嗗弶** 鈥斺€?鏈粨搴撳凡鍥犺繖绫诲垎鍙夊彂鐢熻繃鐪熷疄浜嬫晠
 *锛坄classifyRaccoonFailure` 涓?`classifyLoomyFailure` 鍥涙牸鍒ゆ嵁涓嶄竴鑷达紝
 * 鍗遍櫓鏂瑰悜鎭掑畾鏈濅竴渚э細澶氬啓 24h 鍐峰嵈 鈬?鏁存睜琚皝涓€澶╋級銆?
 *
 * 鈬?鍒ゆ嵁鍙啓鍦ㄨ繖閲屼竴浠斤紝鍚勬笭閬撳彧鎻愪緵銆屾€庝箞鍙栦綑棰濄€嶃€?
 *
 * ## 鍒ゆ嵁
 *
 * 鍙?`active === true` 涓?`remaining > 0` 鐨勫寘閲?`deductionEndTime` 鐨?*鏈€灏忓€?*锛?
 * 涓€涓兘娌℃湁 鈬?`NEVER`锛堥暱鏈燂細鎺掓渶鍚庝絾涓嶅墧闄わ級銆?
 *
 * 鈿狅笍 **鏃犲埌鏈熸椂闂?鈬?`NEVER`锛屼笉鏄?`UNUSABLE`**锛氬寘鏄湁鏁堢殑锛屽彧鏄笉涓嬪彂鍒版湡鏃堕棿
 *锛堝疄娴?lobsterai 鐨?`expiresAt` 鍙负绌轰覆锛夆噿 鍓旈櫎瀹冧細涓㈡帀涓€涓彲鐢ㄦ笭閬撱€?
 * 涓?`codeArtsExpiry` 鐨勩€岃涓嶅埌灏变笉鐚溿€嶅悓涓€鏉″師鍒欍€?
 *
 * @param fetchBalance - 鍙栦綑棰濈殑鍑芥暟锛涜繑鍥?`null` 琛ㄧず鏌ヨ澶辫触 鈬?`UNUSABLE`銆?
 */
async function sharedPackageExpiry(
  fetchBalance: () => Promise<CreditBalance | null>,
): Promise<number> {
  let balance
  try {
    balance = await fetchBalance()
  } catch {
    return UNUSABLE
  }
  if (balance === null) return UNUSABLE
  let earliest = NEVER
  for (const pkg of balance.packages) {
    if (pkg.active !== true) continue
    if (!(typeof pkg.remaining === 'number' && pkg.remaining > 0)) continue
    const end = pkg.deductionEndTime
    if (typeof end === 'number' && Number.isFinite(end) && end > 0 && end < earliest) earliest = end
  }
  return earliest
}

/**
 * lobsterai锛氫笌 buddy **鍚屽舰**锛坄CreditPackage.deductionEndTime` 鐢?
 * `lobsterai-credits.ts` 浠?ISO 8601 鐨?`expiresAt` 褰掍竴鍖栬€屾潵锛夈€?
 *
 * 鈿狅笍 鏈笭閬撴鍓?*涓嶅湪** `WIRED_EXPIRY_PROVIDERS` 閲岋紝鐞嗙敱鏄?
 * `auto-adapter.ts` 閭ｅ彞銆屽叾浣?provider 娌℃湁璺ㄨ处鍙风殑鍒版湡浣欓鎺㈡祴绔偣銆嶁€斺€?
 * **璇ョ悊鐢卞 lobsterai 涓嶆垚绔?*锛堢敤鎴?2026-10-07 璐ㄧ枒鍚庢牳瀹烇級銆?
 */
export async function lobsteraiExpiry(
  credential: LobsteraiCredential,
  product: LobsteraiProduct,
): Promise<number> {
  return sharedPackageExpiry(() => fetchLobsteraiCreditBalance(credential, product))
}

/**
 * trae锛氫笌 buddy **鍚屽舰**锛坄CreditPackage.deductionEndTime` 鐢?
 * `trae-credits.ts` 浠庢潯鐩骇绉掔骇 `expire_time` 鎹㈢畻鑰屾潵锛夈€?
 *
 * 鈿狅笍 鍚?lobsterai锛氭鍓嶈閭ｅ彞锛堜笉鎴愮珛鐨勶級鐞嗙敱鎺掗櫎鍦ㄧ櫧鍚嶅崟澶栥€?
 */
export async function traeExpiry(
  credential: TraeCredential,
  product: TraeProduct,
): Promise<number> {
  return sharedPackageExpiry(() => fetchTraeCreditBalance(credential, product))
}

/** loomy锛氭湁浠婃棩璧犻€?鈫?褰撴棩 24:00锛涘彧鍓╂案涔?鈫?NEVER銆?*/
export async function loomyExpiry(credential: LoomyCredential): Promise<number> {
  let detail
  try {
    detail = await fetchLoomyCreditDetail(credential, LOOMY)
  } catch {
    return UNUSABLE
  }
  if (detail === null) return UNUSABLE
  if (detail.daily > 0) return nextUtc8DayStartMs()
  return detail.permanent > 0 ? NEVER : UNUSABLE
}

/**
 * codearts锛?*绉垎璐︽埛鐨勫埌鏈熸椂闂翠笉鍙煡 鈬?涓€寰?`NEVER`锛堥暱鏈燂級**銆?
 *
 * ## 鈿狅笍鈿狅笍 涓轰粈涔堜笉鍐嶇畻銆屽綋鏃?24:00銆嶏紙鐪熷疄缂洪櫡锛岀敤鎴锋姤闅?2026-10-07锛?
 *
 * 鐢ㄦ埛鐪嬪埌鑱氬悎闈㈡澘鎶?codearts 鍒椾负鍊欓€夛紝闂€宑odearts 涓篃娌℃樉绀虹Н鍒嗕复鏈熴€嶃€?
 *
 * **瀹炴祴鎺㈤拡**锛堟湰鏈轰袱涓湡瀹炶处鍙凤紝鍙 GET `statistics/plugin`锛夛細
 *
 * | 璐﹀彿 | 绫诲瀷 | `credit` |
 * |---|---|---|
 * | `A3E53911` | `isTokenPackage: true`锛圱oken 璁¤垂锛?| `undefined`锛堟棤绉垎鍙ｅ緞锛?|
 * | `82AD9D6E` | `isCreditPackage: true` | `22088.16`锛?*璧犻€?*绉垎鍖咃級 |
 *
 * 涓?`packages[].cycleStartTime` / `cycleEndTime` / `expiredTime` **涓変釜瀛楁瀹炴祴鍏ㄧ┖**
 * 鈥斺€?涓?`codearts-credits.ts` 鐨勬棦鏈夋敞閲婁竴鑷达細銆宍statistics/plugin` **涓嶄笅鍙?*
 * 璧勬簮鍖呯殑鏈夋晥鎬?鍛ㄦ湡瀛楁鈥︹€﹀瀹炵疆涓烘湁鏁堛€佸懆鏈熺暀绌猴紝**鑰屼笉鏄噯閫犱竴涓埌鏈熸椂闂?*銆嶃€?
 *
 * 鈬?鏃у疄鐜帮紙缁ф壙鑷?PR !69 鐨?`auto-adapter.ts` 鎶樼畻琛級鍐欑殑鏄?
 * 銆屾湁绉垎 鈬?`nextUtc8DayStartMs()`锛堜粖鏃?24:00 浣滃簾锛夈€嶁€斺€?閭?*姝ｆ槸鑷嗛€?*锛?
 * 鎺ュ彛娌＄粰杩囨湡鏃堕棿锛屽畼鏂规枃妗ｏ紙README 寮曠敤锛夎鐨勬槸绛惧埌绉垎銆?*鑷彂鏀捐捣 30 澶╁唴鏈夋晥**銆嶏紝
 * 涓よ€呴兘涓嶆槸銆屼粖澶?24:00銆嶃€?
 *
 * **鍚庢灉**锛歝odearts 鐨勫け鏁堟椂鍒昏绠楁垚銆屼粖澶┿€嶁噿 鍦ㄣ€屼复鏈熶紭鍏堛€嶆帓搴忛噷**姘歌繙鎺掓渶鍓?*锛?
 * 鎶㈣蛋浜嗘湰璇ュ厛鐢ㄦ帀鐨?*鐪熸涓存湡**棰濆害锛坆uddy 鐨勮祫婧愬寘 / loomy 鐨勫綋鏃ヨ禒閫侊級銆?
 *
 * 鈬?鏀逛负 `NEVER`锛堥暱鏈熺Н鍒嗭細鎺掓渶鍚庯紝浣?*涓嶅墧闄?* 鈥斺€?娌℃湁涓存湡棰濆害鏃朵粛瑕佺敤瀹冿級銆?
 * 涓庢湰浠撳簱鏃㈡湁鍘熷垯涓€鑷达細**璇讳笉鍒板氨涓嶇寽**锛坄zcodeExpiry` 瀵广€屾煡涓嶅埌銆嶈繑鍥?
 * `UNUSABLE` 鑰岄潪 `NEVER`锛屼篃鏄悓涓€鏉″師鍒欙級銆?
 *
 * 鈿狅笍 涓ょ銆屾棤鍒版湡淇℃伅銆嶇殑鎯呭舰鍦ㄦ湰鍑芥暟閲?*鍚堝苟澶勭悊**锛堥兘杩斿洖 `NEVER`锛夛細
 * 鏈夌Н鍒嗭紙鍒版湡鏈煡锛変笌鏃犵Н鍒嗭紙Token 璁¤垂璐︽埛 / 浣欓涓?0锛夈€備袱鑰呭湪鎺掑簭涓婂悓涓?
 * 銆屼笉涓存湡銆嶏紝涓?*閮戒笉璇ヨ鍓旈櫎** 鈥斺€?璐﹀彿鏈韩鏄彲鐢ㄧ殑銆?
 * 杩欎笌 `buddyExpiry` 鐨勩€屾棤鏈夋晥鍖?鈫?NEVER銆嶆槸鍚屼竴鍙ｅ緞銆?
 *
 * 鈿狅笍 鑻ュ皢鏉ユ帴鍙ｅ紑濮嬩笅鍙戝懆鏈熷瓧娈碉紝搴旀敼涓鸿鐪熷疄鍊硷紙`packages[].expiredTime` 绛夛級锛?
 * **涓嶈**鎭㈠鎴愭煇涓浐瀹氫及绠椼€?
 */
export async function codeArtsExpiry(credential: CodeArtsCredential): Promise<number> {
  let result
  try {
    result = await fetchCodeArtsAccountInfoDetailed(credential)
  } catch {
    return UNUSABLE
  }
  // 鏌ヤ笉鍒?/ 缁撴瀯寮傚父 鈬?UNUSABLE锛堝墧闄わ級锛屼笌銆屾煡鍒颁簡浣嗘病鏈夊埌鏈熸蹇点€嶄弗鏍煎尯鍒嗐€?
  if (!result.ok) return UNUSABLE
  return NEVER
}

/** zcode锛氬悇妗?`expiresAt`锛堢锛夋渶灏忓€硷紱鏃犳《浣嗘湁鍙娲诲姩 鈫?褰撴棩 24:00銆?*/
export async function zcodeExpiry(credential: ZcodeCredential): Promise<number> {
  let balance
  try {
    balance = await fetchZcodeBalance(credential)
  } catch {
    return UNUSABLE
  }
  // 鈿狅笍 `undefined` 琛ㄧず銆岃繖娆℃煡涓嶅埌銆嶏紝涓嶆槸銆屾病鏈変綑棰濄€嶁€斺€?鎶樼畻鎴?`NEVER` 浼氳
  //    涓€涓煡涓嶅埌浣欓鐨勬笭閬撲互銆屾案涔呯Н鍒嗐€嶈韩浠藉弬涓庤疆鎹€?
  if (balance === undefined) return UNUSABLE
  let earliest = NEVER
  for (const bucket of balance.buckets) {
    const remaining = bucket.availableUnits ?? bucket.remainingUnits ?? 0
    if (!(remaining > 0)) continue
    const exp = bucket.expiresAt
    if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0) {
      const ms = exp * 1000
      if (ms < earliest) earliest = ms
    }
  }
  if (earliest !== NEVER) return earliest
  // 妗堕噷娌℃湁甯﹀埌鏈熸椂闂寸殑浣欓锛氳嫢杩樻湁鍙鐨勬瘡鏃ユ椿鍔紝鎸夊綋鏃ラ搴︾畻锛堝厛鐑у畠锛夈€?
  if (balance.remaining > 0 || (balance.claimablePlans?.length ?? 0) > 0) return nextUtc8DayStartMs()
  return NEVER
}

/**
 * zcode 鐨勯搴︽《鏄?*鎸夋ā鍨嬬粦瀹?*鐨勶紙鐢ㄦ埛瀹炴祴 2026-10-07锛夛細璐﹀彿鏈変綑棰?鈮?浠绘剰
 * 妯″瀷鍙敤 鈥斺€?渚嬪浣欓鍙寕鍦?`GLM-5.3-Flash` 涓婃椂锛岃姹傚叾瀹冩ā鍨嬶紙鍚仛鍚堢洰褰?
 * 娲剧敓鐨勫彉浣撳悕锛変細涓婃父杩斿洖 200 绌烘祦 +銆岄搴﹀凡鐢ㄥ敖銆嶏紙`QUOTA_EXCEEDED`锛夈€?
 *
 * 鏈嚱鏁板洖绛斻€?*杩欎釜璐﹀彿鐨勪綑棰濊兘涔板摢浜涙ā鍨?*銆嶏細鏀堕泦**鏈変綑棰濈殑妗?*鐨?
 * `showName`锛堜笂娓告敞閲婃槑鍐欍€屽疄娴嬩负妯″瀷鍚嶏紝濡?`GLM-5.3-Flash`銆嶏級锛屼緵閫夊瀷灞傛妸
 * zcode 鐨勫€欓€?*绾︽潫**鍒拌繖浜涙ā鍨嬩笂銆?
 *
 * 鈿狅笍 涓?{@link zcodeExpiry} 鍚屾簮涓嶅悓闂細閭ｄ釜鍥炵瓟銆屼粈涔堟椂鍊欎綔搴熴€嶏紙娓犻亾绾ф帓搴忥級锛?
 * 鏈嚱鏁板洖绛斻€岄挶鑳借姳鍦ㄥ摢涓ā鍨嬩笂銆嶏紙鍊欓€夎繃婊わ級銆傛煡璇㈠け璐ヨ繑鍥?`undefined`
 * 锛? 涓嶇煡閬擄紝璋冪敤鏂?*涓嶅緱**鎹鏀剁獎 鈥斺€?涓庛€屽畞鍙皯绛涳紝涓嶅彲璇墧銆嶅悓涓€鍙栬垗锛夈€?
 */
export async function zcodeQuotaModelIds(
  credential: ZcodeCredential,
): Promise<readonly string[] | undefined> {
  let balance
  try {
    balance = await fetchZcodeBalance(credential)
  } catch {
    return undefined
  }
  if (balance === undefined) return undefined
  const ids: string[] = []
  for (const bucket of balance.buckets) {
    const remaining = bucket.availableUnits ?? bucket.remainingUnits ?? 0
    if (!(remaining > 0)) continue
    const name = bucket.showName
    if (typeof name === 'string' && name.trim().length > 0) ids.push(name.trim())
  }
  return ids
}
