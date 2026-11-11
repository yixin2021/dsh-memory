/**
 * 设置页的动作分发（纯逻辑，不依赖任何宿主模块）。
 *
 * 抽出来单独放，是为了让 `node --test` 能在没有 dsh 运行时的环境里直接验证
 * 分发语义——`index.js` 一旦 import `@deepseek-ai/dsh-tools` 就跑不起来了。
 */

/**
 * 分发一次设置页请求。
 * @param service - 记忆服务（只需 list / remove / clear 三个方法）。
 * @param request - 已解析的 JSON 体。
 * @returns 可直接序列化的应答。
 */
export async function dispatchManagement(service, request) {
  const action = request?.action
  if (action === 'list') {
    const listed = await service.list()
    return { ok: true, ...listed }
  }
  if (action === 'delete') {
    const result = await service.remove(request?.id)
    return { ok: result.status === 'accepted', ...result }
  }
  if (action === 'clear') {
    // 清空不可逆，必须由界面显式带上确认位。
    if (request?.confirm !== true) {
      return { ok: false, code: 'confirm-required', message: 'Clearing the store needs confirm: true.' }
    }
    const result = await service.clear()
    return { ok: result.status === 'accepted', ...result }
  }
  return { ok: false, code: 'unknown-action', message: `Unknown action "${String(action)}".` }
}
