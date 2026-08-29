// plan-crypto.js - 每日计划页面的 AES-256-GCM 加密/解密库

/**
 * 从密码派生加密密钥
 * @param {string} password - 用户输入的密码
 * @param {Uint8Array} salt - 盐值
 * @returns {Promise<CryptoKey>}
 */
async function deriveKey(password, salt) {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 300000,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

/**
 * Base64 解码为 Uint8Array
 */
function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * 解密函数
 * @param {string} password - 密码
 * @param {Object} encryptedData - {salt, iv, ciphertext} (base64编码)
 * @returns {Promise<string>} 解密后的明文
 */
async function decrypt(password, encryptedData) {
  const salt = base64ToUint8Array(encryptedData.salt);
  const iv = base64ToUint8Array(encryptedData.iv);
  const ciphertext = base64ToUint8Array(encryptedData.ciphertext);

  const key = await deriveKey(password, salt);

  try {
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      ciphertext
    );

    const decoder = new TextDecoder();
    return decoder.decode(decryptedBuffer);
  } catch (e) {
    throw new Error('DECRYPT_FAILED');
  }
}

/**
 * 验证密码并解密内容，渲染到目标元素
 * @param {string} password - 密码
 * @param {string} encryptedDataId - 存储加密数据的 script 标签 id
 * @param {string} targetElementId - 要渲染内容的目标元素 id
 * @param {string} cacheKey - sessionStorage 缓存键名
 * @returns {Promise<boolean>} 是否成功
 */
async function checkPasswordAndDecrypt(password, encryptedDataId, targetElementId, cacheKey) {
  // 先检查缓存
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) {
    document.getElementById(targetElementId).innerHTML = cached;
    return true;
  }

  // 读取加密数据
  const encryptedDataEl = document.getElementById(encryptedDataId);
  if (!encryptedDataEl) {
    throw new Error('加密数据未找到');
  }

  const encryptedData = JSON.parse(encryptedDataEl.textContent);

  try {
    const decrypted = await decrypt(password, encryptedData);

    // 渲染到页面
    document.getElementById(targetElementId).innerHTML = decrypted;

    // 缓存到 sessionStorage
    sessionStorage.setItem(cacheKey, decrypted);

    return true;
  } catch (e) {
    return false;
  }
}
