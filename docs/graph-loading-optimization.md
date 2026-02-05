# 图谱加载性能问题分析与优化方案

## 问题描述

首屏加载完成后立即跳转会导致下一个页面的局部图谱需要较长时间加载（可能数秒），但如果等待片刻再跳转则加载很快。

## 根本原因分析

### 异步加载流程

```
页面加载
  → nav 事件触发
    → renderLocalGraph()
      → renderGraph()
        → [瓶颈1] await fetchData（全局共享数据）
        → [瓶颈2] 遍历所有节点构建链接图
        → 过滤邻域节点（基于 depth 配置）
        → [瓶颈3] 初始化 Pixi Application（GPU资源）
        → [瓶颈4] 创建 D3 Simulation（开始力导向布局计算）
        → renderGraph 返回
      → renderLocalGraph 完成
    → 注册事件监听器
    → [日志] nav 事件处理完成 ← 代码执行完毕
    
  → [异步继续] D3 Simulation 在后台计算布局（300次迭代）
  → [日志] D3 simulation 布局计算完成（已收敛）← 真正完成！
```

### 关键瓶颈

#### 1. 全局共享的 fetchData

- `fetchData` 是全局单例 Promise，首次调用触发网络请求
- 首屏加载时如果立即跳转，下一页面会阻塞在 `await fetchData`
- **影响时长**：取决于 `contentIndex.json` 文件大小和网络速度

#### 2. 全量数据处理

即使 `depth: 1`（只显示1层邻居），代码仍需：
- 遍历**所有**节点构建完整的链接关系图
- 然后才基于 `depth` 过滤出邻域节点
- **问题**：前期处理是 O(n) 复杂度，n 为总节点数

#### 3. D3 Simulation 收敛计算

- Simulation 是物理模拟过程，默认运行约 300 次迭代
- 计算复杂度：O(n²)，n 为参与计算的节点数
- 即使只显示少量邻居，如果某页面链接众多，邻域节点也可能有几百个
- **影响时长**：从"nav 事件处理完成"到"simulation 收敛"可能耗时数秒

#### 4. 并发资源竞争

首屏加载后立即跳转时：
- CPU：前一页面的 simulation 仍在密集计算
- GPU：Pixi 渲染资源被占用
- 网络：fetchData 可能尚未完成
- **结果**：新页面加载被拖慢

## 优化方案对比

### 方案1：首屏加载守护（临时方案）

**实现**：
- 监听首屏的 simulation end 事件
- 在收敛前禁止所有导航操作
- 显示 toast 提示"系统正在初始化"

**优点**：
- ✅ 实现简单，改动最小
- ✅ 保证首次加载体验一致
- ✅ 避免用户遇到卡顿

**缺点**：
- ❌ 治标不治本，只是隐藏问题
- ❌ 强制用户等待，体验不佳
- ❌ 不解决根本的性能问题

**适用场景**：快速修复，临时缓解用户体验问题

---

### 方案2：预计算局部图谱数据（根治方案）

**实现**：
- 构建时为每个页面预计算其局部图谱数据
- 将邻域节点和链接直接序列化到 HTML 中
- 运行时直接使用预计算数据，跳过全量处理

**优点**：
- ✅ 彻底解决全量数据处理问题
- ✅ 首屏加载只需处理当前页面数据
- ✅ 无需 fetchData，无网络延迟
- ✅ simulation 节点数固定，收敛时间可控

**缺点**：
- ❌ 构建时间增加（需为每个页面计算图谱）
- ❌ HTML 文件体积增大（嵌入图谱数据）
- ❌ 增量构建需要重新计算受影响页面的图谱
- ❌ 实现复杂度高，需要大量重构

**技术细节**：
```typescript
// 构建时生成（在 emitter 中）
interface PrecomputedGraphData {
  nodes: Array<{ id: string; title: string; tags: string[] }>
  links: Array<{ source: string; target: string }>
}

// 嵌入 HTML
<div class="graph-container" 
     data-cfg="{...}" 
     data-precomputed="{nodes: [...], links: [...]}">
</div>

// 运行时直接使用
const precomputed = JSON.parse(container.dataset.precomputed)
// 跳过 fetchData 和全量处理
```

---

### 方案3：延迟加载 + 异步优化（推荐方案）

**这是我推荐的综合方案**，结合多个优化点：

#### 3.1 预加载 fetchData

```typescript
// 在页面脚本加载时立即触发 fetchData
// 而不是等到 renderGraph 时才触发
if (!(window as any).graphFetchDataStarted) {
  (window as any).graphFetchDataStarted = true
  fetchData.then(() => {
    console.log("[Graph] Content index preloaded")
  })
}
```

**优点**：首屏加载期间，fetchData 在后台并行下载

#### 3.2 优化邻域计算

不遍历所有节点，而是从当前页面开始 BFS/DFS：

```typescript
// 当前实现：遍历所有节点构建完整 links
for (const [source, details] of data.entries()) { ... }  // O(n)

// 优化后：只处理邻域相关节点
function computeNeighbourhood(startSlug: string, depth: number) {
  const visited = new Set<string>()
  const queue = [{ slug: startSlug, depth: 0 }]
  
  while (queue.length > 0) {
    const { slug, depth: currentDepth } = queue.shift()!
    if (currentDepth > depth || visited.has(slug)) continue
    
    visited.add(slug)
    const nodeData = data.get(slug)
    if (nodeData) {
      // 只处理这个节点的链接
      for (const link of nodeData.links) {
        queue.push({ slug: link, depth: currentDepth + 1 })
      }
    }
  }
  
  return visited
}
```

**优点**：只处理实际需要的节点，从 O(总节点数) 降到 O(邻域节点数)

#### 3.3 降低 Simulation 收敛标准

对于局部图谱，不需要等到完全收敛：

```typescript
if (!isGlobalGraph) {
  // 局部图谱：更快收敛
  simulation.alphaMin(0.01)  // 默认 0.001，提高阈值让它更早停止
  simulation.alphaDecay(0.05) // 默认 0.0228，加快衰减速度
}
```

**优点**：局部图谱收敛时间减少 50%+，视觉效果差异不大

#### 3.4 缓存虚拟节点索引

```typescript
let cachedVirtualNodeData: Map<...> | null = null

if (!cachedVirtualNodeData) {
  const response = await fetch("/static/virtualNodeIndex.json")
  cachedVirtualNodeData = ...
}
```

**优点**：避免每次 renderGraph 都重新请求

#### 3.5 渐进式渲染（可选）

```typescript
// 先渲染核心节点，simulation 稳定后再添加边缘节点
const coreNodes = filterCoreNodes(allNodes)
simulation.nodes(coreNodes)
// ... 初始化

requestIdleCallback(() => {
  // 用户交互空闲时再添加边缘节点
  addEdgeNodes()
})
```

---

### 方案对比总结

| 方案 | 实现难度 | 效果 | 构建成本 | 推荐度 |
|------|---------|------|---------|--------|
| 方案1：加载守护 | ⭐ 简单 | ⭐⭐ 临时缓解 | 无 | ⭐⭐ |
| 方案2：预计算 | ⭐⭐⭐⭐⭐ 复杂 | ⭐⭐⭐⭐⭐ 根治 | 高 | ⭐⭐⭐ |
| 方案3：综合优化 | ⭐⭐⭐ 中等 | ⭐⭐⭐⭐ 显著改善 | 低 | ⭐⭐⭐⭐⭐ |

## 推荐实施策略

### 短期（立即实施）

1. **预加载 fetchData**（方案 3.1）
   - 改动小，效果明显
   - 预计改善 30-50% 的首次加载时间

2. **缓存虚拟节点索引**（方案 3.4）
   - 避免重复网络请求

3. **降低局部图谱收敛标准**（方案 3.3）
   - 减少等待时间，用户几乎无感知

### 中期（有时间再做）

4. **优化邻域计算算法**（方案 3.2）
   - 需要重构，但收益巨大
   - 对大型知识库提升显著

5. **可选：添加加载守护**（方案 1）
   - 作为兜底方案，保证最差情况下的体验

### 长期（理想状态）

6. **考虑预计算方案**（方案 2）
   - 适合构建后完全静态部署的场景
   - 需要权衡构建时间和运行性能

## 性能目标

- 首屏加载后立即跳转，下一页面图谱加载时间 < 500ms
- 避免用户感知到"卡顿"或"等待"
- 在大型知识库（1000+ 节点）下依然流畅

## 后续监控

建议保留调试日志，监控关键指标：
- `fetchData` 耗时
- 邻域节点数量
- simulation 收敛时间
- 从 nav 事件到 simulation end 的总时长
