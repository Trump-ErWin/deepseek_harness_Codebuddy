/**
 * 备份载荷的**纯函数**工具（无 React、无 Web Crypto，可直接单测）。
 *
 * 为什么需要裁剪：合并导入（`mode: 'merge'`）的判重发生在**后端**，它只知道
 * 「这份载荷里有哪些账号」，不知道用户在界面上勾了哪几个。若不先裁剪，用户
 * 从别人的整份备份里只勾一个账号，后端仍会把备份里**其余**账号一并追加进来；
 * 更糟的是凭据写入 —— 备份里那些不在勾选范围内的 `credentialRef` 可能已经被
 * 本机现有账号占用，写进去等于**覆盖现有账号的凭据**，与「只增加不覆盖」的
 * 承诺相反。
 *
 * 故裁剪必须发生在**发请求之前**，且要同时裁掉三个地方：`accounts`、
 * `credentials`（只留被选中账号引用的 ref），以及 `disabledModels`
 * （合并模式本就不使用它，清空可避免被误写成「整体替换」语义的载荷）。
 *
 * ⚠️ **不要**在这里做任何凭据解密或改写：`credentials` 的值是凭据 JSON
 * **原文字符串**，必须原样搬运（后端按存储契约回写）。
 */

/**
 * 把备份载荷裁剪成只含指定账号。
 *
 * @param {object} payload 解密后的备份载荷（`dsh-codearts-auth/backup`）。
 * @param {readonly string[]} accountIds 要保留的账号 id。
 * @returns {object} 新的载荷对象（不修改入参）。`accountIds` 为空时返回一份
 *   `accounts` 为空、`credentials` 为空的载荷 —— 调用方应在此之前拦下「一个
 *   都没勾」的情况并给出提示，而不是发一份空载荷。
 */
export function trimBackupPayload(payload, accountIds) {
  const wanted = new Set(Array.isArray(accountIds) ? accountIds : []);
  const accounts = (Array.isArray(payload?.accounts) ? payload.accounts : [])
    .filter((entry) => entry !== null && typeof entry === 'object' && wanted.has(entry.id));
  // 只保留被选中账号实际引用的凭据 ref：备份里可能存在账号池之外的独立凭据
  // （各 provider 的默认单凭据 ref），它们在「只加一个账号」的语境下不该被写入。
  const refs = new Set(
    accounts
      .map((entry) => entry.credentialRef)
      .filter((ref) => typeof ref === 'string' && ref.length > 0),
  );
  const credentials = {};
  const source = payload?.credentials !== null && typeof payload?.credentials === 'object'
    ? payload.credentials
    : {};
  for (const [ref, value] of Object.entries(source)) {
    if (refs.has(ref)) credentials[ref] = value;
  }
  return {
    ...payload,
    accounts,
    credentials,
    // 合并模式不消费黑名单；给出空表而不是照搬原值，是为了让这份载荷**无论
    // 被哪个版本的后端当成整体替换处理**都不会改动模型开关（防误伤）。
    disabledModels: {},
  };
}

/**
 * 从备份载荷里取出可勾选的账号摘要（导入弹窗用）。
 *
 * 与 `backup.status` 的 `accountList` 同构，便于两个弹窗共用同一段渲染。
 * 坏条目（缺 id）直接丢弃 —— 它们本来也进不了账号池。
 */
export function describeBackupAccounts(payload) {
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  return accounts
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.length > 0)
    .map((entry) => ({
      id: entry.id,
      provider: typeof entry.provider === 'string' ? entry.provider : '',
      nickname: typeof entry.nickname === 'string' && entry.nickname.length > 0 ? entry.nickname : entry.id,
      enabled: entry.enabled !== false,
    }));
}
