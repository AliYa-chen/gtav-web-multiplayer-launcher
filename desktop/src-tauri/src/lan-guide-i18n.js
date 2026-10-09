import { initLanguage, getLanguage, onLanguageChange } from '/i18n.js';

// Localized text only. Host identity and certificate URLs stay in the launcher's
// injected LAN_SETTINGS and never enter HTML templates.
export const guideMessages = Object.freeze({
  'guide.title': ['GTA5DATA · 局域网证书安装', 'GTA5DATA · LAN Certificate Setup'],
  'guide.brand': ['GTA5DATA · 局域网共享', 'GTA5DATA · LAN Sharing'],
  'guide.headline': ['信任资源主机，即可进入游戏', 'Trust the resource host to enter the game'],
  'guide.intro': ['你正在通过 HTTP 打开安装引导。游戏需要可信 HTTPS，首次使用局域网共享时，请下载启动器提供的 CA 公共证书，并在系统中安装和信任。下载不会自动安装证书。', 'This setup guide is open over HTTP. The game requires trusted HTTPS. When using LAN sharing for the first time, download the launcher’s public CA certificate, then install and trust it in your system. Downloading does not install the certificate automatically.'],
  'guide.confirm': ['确认资源主机', 'Verify the resource host'],
  'guide.fingerprint': ['向开启共享的朋友核对以下 SHA-256 指纹，确认一致后再信任。HTTP 页面本身不能证明主机身份。', 'Compare this SHA-256 fingerprint with the friend sharing the resources. Trust the certificate only after they match. This HTTP page cannot prove the host’s identity.'],
  'guide.certificate': ['启动器使用同一张固定 CA，为资源主机当前 IP 签发 HTTPS 证书。浏览器仅下载 CA 公共证书；HTTP 页面不会提供私钥。信任这张 CA 后，可访问使用同一 CA 的资源主机和不同游戏端口，无需重复安装。', 'The launcher uses a fixed CA to issue an HTTPS certificate for the resource host’s current IP. The browser downloads only the public CA certificate; this HTTP page never provides a private key. Once you trust this CA, resource hosts and game ports using the same CA do not require another installation.'],
  'guide.download': ['下载启动器 CA 证书', 'Download Launcher CA Certificate'],
  'guide.retry': ['重新检测', 'Check Again'],
  'guide.enter': ['手动进入 HTTPS 游戏', 'Enter HTTPS Game Manually'],
  'guide.afterTrust': ['安装并信任后，本页会自动检测并进入游戏；刷新也会检测。如果浏览器仍不接受证书，请完全退出并重新打开浏览器。请保留 CA 身份，不要仅点击忽略网站证书错误。', 'After installation and trust, this page checks automatically and opens the game; refreshing also checks. If the browser still rejects the certificate, quit it completely and reopen it. Keep the CA identity intact; do not simply bypass the website’s certificate warning.'],
  'windows.open': ['打开下载的 GTA5DATA-LAN-CA.cer，点击“安装证书”。', 'Open the downloaded GTA5DATA-LAN-CA.cer and select “Install Certificate”.'],
  'windows.store': ['选择“当前用户”。选择“将所有的证书都放入下列存储”，浏览并选择“受信任的根证书颁发机构”。', 'Select “Current User”. Choose “Place all certificates in the following store”, then browse to “Trusted Root Certification Authorities”.'],
  'windows.finish': ['完成安装，核对指纹并确认安全提示；返回本页，点击“重新检测”或刷新。', 'Complete installation, verify the fingerprint, and confirm the security prompt. Return here and select “Check Again” or refresh.'],
  'windows.firefox': ['Edge、Chrome 通常使用系统信任。Firefox 若未采用系统根证书，可在设置 → 隐私与安全 → 证书 → 查看证书 → 证书颁发机构中导入，并允许标识网站。', 'Edge and Chrome usually use system trust. If Firefox does not use system root certificates, import the CA under Settings → Privacy & Security → Certificates → View Certificates → Authorities and allow it to identify websites.'],
  'mac.open': ['打开下载的 CA 证书，导入“钥匙串访问”中的“登录”钥匙串。', 'Open the downloaded CA certificate and import it into the “login” keychain in Keychain Access.'],
  'mac.trust': ['找到 BinGo Root CA，双击 → 展开“信任”，将“使用此证书时”设为“始终信任”。', 'Find BinGo Root CA, double-click it, expand “Trust”, and set “When using this certificate” to “Always Trust”.'],
  'mac.finish': ['关闭证书详情，按系统提示确认；返回本页重新检测，必要时退出并重新打开浏览器。', 'Close the certificate details and confirm the system prompt. Return here to check again. Quit and reopen your browser if needed.'],
  'mac.remove': ['结束使用后，可在“登录”钥匙串中删除不再需要的 CA。', 'When you no longer need the CA, you can remove it from the “login” keychain.'],
  'guide.gpu': ['进入游戏后，各设备使用自己的 GPU 运行游戏，并按需从资源主机读取资源。请使用支持本项目 WebGPU 的桌面浏览器。', 'Each device runs the game on its own GPU and loads resources from the host as needed. Use a desktop browser that supports this project’s WebGPU requirements.'],
  'status.checking': ['正在检测 HTTPS 证书信任…', 'Checking HTTPS certificate trust…'],
  'status.verified': ['已验证资源主机证书，正在进入游戏…', 'Resource host certificate verified. Entering the game…'],
  'status.mismatch': ['证书身份不一致，请核对资源主机上显示的指纹。', 'Certificate identity does not match. Check the fingerprint shown on the resource host.'],
  'status.untrusted': ['尚未通过 HTTPS 验证。请安装并信任资源主机 CA，然后刷新或点击重新检测。', 'HTTPS verification has not passed yet. Install and trust the resource host’s CA, then refresh or select Check Again.'],
});

export function translateGuideText(key) {
  return guideMessages[key]?.[getLanguage() === 'en' ? 1 : 0] || key;
}

export async function installLanGuide() {
  const settings = window.LAN_SETTINGS;
  const status = document.getElementById('status');
  document.getElementById('fingerprint').textContent = settings.fingerprint;
  document.getElementById('enter').href = settings.httpsUrl;
  let statusKey = 'status.checking', timer = 0, closed = false;
  function render() {
    document.documentElement.lang = getLanguage();
    for (const element of document.querySelectorAll('[data-lan-i18n]')) {
      element.textContent = translateGuideText(element.dataset.lanI18n);
    }
    status.textContent = translateGuideText(statusKey);
  }
  await initLanguage();
  render();
  const stopLanguage = onLanguageChange(render);
  const probe = window.GTA5LanProbe.createProbe({ ...settings,
    translate: translateGuideText,
    redirect: url => window.location.replace(url),
    status: (text, ready, key) => { statusKey = key; status.textContent = text; },
  });
  document.getElementById('retry').addEventListener('click', () => probe.check());
  async function check() {
    if (closed) return;
    const ready = await probe.check();
    if (!closed && !ready) timer = window.setTimeout(check, 4000);
  }
  window.addEventListener('pagehide', () => { closed = true; window.clearTimeout(timer); stopLanguage(); }, { once: true });
  check();
  return probe;
}

installLanGuide();
