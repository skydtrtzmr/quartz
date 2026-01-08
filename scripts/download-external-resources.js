/**
 * 下载外部静态资源到本地
 * 用于将 CDN 资源本地化
 */

import fs from 'fs';
import path from 'path';
import https from 'https';

// 资源配置
const resources = [
  // Google Fonts 字体文件
  {
    url: 'https://fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n5ig.ttf',
    dest: 'quartz/static/fonts/-F63fjptAgt5VM-kVkqdyU8n5ig.ttf'
  },
  {
    url: 'https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3vAO8lc.ttf',
    dest: 'quartz/static/fonts/-F6qfjptAgt5VM-kVkqdyU8n3vAO8lc.ttf'
  },
  {
    url: 'https://fonts.gstatic.com/s/schibstedgrotesk/v7/JqzI5SSPQuCQF3t8uOwiUL-taUTtap9DcSQBg_nT9FQY6oLoDMhq.ttf',
    dest: 'quartz/static/fonts/JqzI5SSPQuCQF3t8uOwiUL-taUTtap9DcSQBg_nT9FQY6oLoDMhq.ttf'
  },
  {
    url: 'https://fonts.gstatic.com/s/schibstedgrotesk/v7/JqzI5SSPQuCQF3t8uOwiUL-taUTtap9DcSQBg_nT9FQY6oIPC8hq.ttf',
    dest: 'quartz/static/fonts/JqzI5SSPQuCQF3t8uOwiUL-taUTtap9DcSQBg_nT9FQY6oIPC8hq.ttf'
  },
  {
    url: 'https://fonts.gstatic.com/s/schibstedgrotesk/v7/JqzK5SSPQuCQF3t8uOwiUL-taUTtarVKQ9vZ6pJJWlMNIsEATw.ttf',
    dest: 'quartz/static/fonts/JqzK5SSPQuCQF3t8uOwiUL-taUTtarVKQ9vZ6pJJWlMNIsEATw.ttf'
  },
  {
    url: 'https://fonts.gstatic.com/s/schibstedgrotesk/v7/JqzK5SSPQuCQF3t8uOwiUL-taUTtarVKQ9vZ6pJJWlMNxcYATw.ttf',
    dest: 'quartz/static/fonts/JqzK5SSPQuCQF3t8uOwiUL-taUTtarVKQ9vZ6pJJWlMNxcYATw.ttf'
  },
  {
    url: 'https://fonts.gstatic.com/s/sourcesanspro/v23/6xK1dSBYKcSV-LCoeQqfX1RYOo3qPa7g.ttf',
    dest: 'quartz/static/fonts/6xK1dSBYKcSV-LCoeQqfX1RYOo3qPa7g.ttf'
  },
  {
    url: 'https://fonts.gstatic.com/s/sourcesanspro/v23/6xKwdSBYKcSV-LCoeQqfX1RYOo3qPZY4lBdr.ttf',
    dest: 'quartz/static/fonts/6xKwdSBYKcSV-LCoeQqfX1RYOo3qPZY4lBdr.ttf'
  },
  {
    url: 'https://fonts.gstatic.com/s/sourcesanspro/v23/6xK3dSBYKcSV-LCoeQqfX1RYOo3aPw.ttf',
    dest: 'quartz/static/fonts/6xK3dSBYKcSV-LCoeQqfX1RYOo3aPw.ttf'
  },
  {
    url: 'https://fonts.gstatic.com/s/sourcesanspro/v23/6xKydSBYKcSV-LCoeQqfX1RYOo3i54rAkA.ttf',
    dest: 'quartz/static/fonts/6xKydSBYKcSV-LCoeQqfX1RYOo3i54rAkA.ttf'
  },
  // KaTeX 资源
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css',
    dest: 'quartz/static/katex/katex.min.css'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/copy-tex.min.js',
    dest: 'quartz/static/katex/copy-tex.min.js'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Main-Regular.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_Main-Regular.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Math-Italic.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_Math-Italic.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Size1-Regular.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_Size1-Regular.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Size2-Regular.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_Size2-Regular.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Size3-Regular.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_Size3-Regular.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Size4-Regular.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_Size4-Regular.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_AMS-Regular.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_AMS-Regular.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Caligraphic-Bold.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_Caligraphic-Bold.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Caligraphic-Regular.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_Caligraphic-Regular.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Fraktur-Bold.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_Fraktur-Bold.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Fraktur-Regular.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_Fraktur-Regular.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Main-Bold.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_Main-Bold.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Main-BoldItalic.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_Main-BoldItalic.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Main-Italic.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_Main-Italic.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_SansSerif-Bold.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_SansSerif-Bold.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_SansSerif-Italic.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_SansSerif-Italic.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_SansSerif-Regular.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_SansSerif-Regular.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Script-Regular.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_Script-Regular.woff2'
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/KaTeX_Typewriter-Regular.woff2',
    dest: 'quartz/static/katex/fonts/KaTeX_Typewriter-Regular.woff2'
  },
  // Mermaid 资源
  {
    url: 'https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.4.0/mermaid.esm.min.mjs',
    dest: 'quartz/static/mermaid/mermaid.esm.min.mjs'
  }
];

// 确保目录存在
function ensureDir(filePath) {
  const dirname = path.dirname(filePath);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
}

// 下载文件
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    ensureDir(dest);
    const file = fs.createWriteStream(dest);
    
    console.log(`正在下载: ${url}`);
    
    https.get(url, (response) => {
      // 处理重定向
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(response.headers.location, dest)
          .then(resolve)
          .catch(reject);
      }
      
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`下载失败: ${response.statusCode}`));
      }
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        console.log(`✓ 已保存: ${dest}`);
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

// 主函数
async function main() {
  console.log('开始下载外部资源...\n');
  
  let success = 0;
  let failed = 0;
  
  for (const resource of resources) {
    try {
      await downloadFile(resource.url, resource.dest);
      success++;
    } catch (error) {
      console.error(`✗ 下载失败 ${resource.url}: ${error.message}`);
      failed++;
    }
  }
  
  console.log(`\n下载完成！成功: ${success}, 失败: ${failed}`);
  
  // 修改 KaTeX CSS 中的字体路径
  try {
    console.log('\n正在修改 KaTeX CSS 字体路径...');
    const cssPath = 'quartz/static/katex/katex.min.css';
    let cssContent = fs.readFileSync(cssPath, 'utf-8');
    // 将 fonts/ 路径改为相对路径
    cssContent = cssContent.replace(/fonts\//g, './fonts/');
    fs.writeFileSync(cssPath, cssContent);
    console.log('✓ KaTeX CSS 字体路径已更新');
  } catch (error) {
    console.error(`✗ 修改 KaTeX CSS 失败: ${error.message}`);
  }
  
  if (failed > 0) {
    console.log('\n提示：部分资源下载失败，你可以手动下载这些文件');
    process.exit(1);
  }
}

main().catch(console.error);
