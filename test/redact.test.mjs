import assert from 'node:assert/strict'
import test from 'node:test'

import { PATH_PLACEHOLDER, looksLikeSecret, redactPaths, truncateUtf16 } from '../lib/redact.js'

test('macOS / Linux 绝对路径被替换', () => {
  const { text, removedCount } = redactPaths('配置在 /Users/ligudian/proj 与 /etc/nginx/nginx.conf')
  assert.equal(removedCount, 1, '仅 /Users 前缀在脱敏列表内，/etc 不在其中')
  assert.ok(text.includes(PATH_PLACEHOLDER))
  assert.ok(!text.includes('/Users/ligudian/proj'))
})

test('家目录与 Windows 盘符路径被替换', () => {
  const { text, removedCount } = redactPaths('cwd is ~/code/dsh-plugins and C:\\Users\\me\\AppData')
  assert.equal(removedCount, 2)
  assert.equal(text, `cwd is ${PATH_PLACEHOLDER} and ${PATH_PLACEHOLDER}`)
})

test('正文中的相对路径不被误伤', () => {
  const { text, removedCount } = redactPaths('见 src/lib/archive.js 与 ./test')
  assert.equal(removedCount, 0)
  assert.equal(text, '见 src/lib/archive.js 与 ./test')
})

test('空输入的脱敏是无操作', () => {
  assert.deepEqual(redactPaths(''), { text: '', removedCount: 0 })
  assert.deepEqual(redactPaths(undefined), { text: '', removedCount: 0 })
})

test('截断不切断代理对', () => {
  const emoji = 'ab\u{1F600}cd'
  assert.equal(truncateUtf16(emoji, 3), 'ab')
  assert.equal(truncateUtf16(emoji, 4), 'ab\u{1F600}')
  assert.equal(truncateUtf16('abc', 10), 'abc')
  assert.equal(truncateUtf16('abc', 0), '')
})

test('密钥形态被识别', () => {
  assert.ok(looksLikeSecret('token sk-abcdefghijklmnopqrstuvwx'))
  assert.ok(looksLikeSecret('ghp_abcdefghijklmnopqrstuvwxyz0123'))
  assert.ok(looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----'))
  assert.ok(!looksLikeSecret('用户偏好使用 pnpm 而非 npm'))
})
