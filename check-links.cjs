const fs = require('fs');
const d = JSON.parse(fs.readFileSync('E:/ProgramProjects/VScode_projects/quartz-fullstack/output/xm2/static/contentIndex.json', 'utf8'));

// Find index key
const idx = Object.keys(d).find(k => k === 'index' || k.endsWith('/index'));
console.log('index key:', idx);
console.log('index links:', d[idx]?.links);
console.log('sample backlink file links:', d['项目/测试聚合1']?.links);

// Check if any file links to index
const backlinkFiles = Object.keys(d).filter(k => {
  const links = d[k]?.links;
  if (!links) return false;
  return links.includes(idx) || links.includes('/') || links.includes('index');
});
console.log('Files linking to index:', backlinkFiles);
