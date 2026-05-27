---
date: 2026-05-27
topic: ui-redesign
---

# Admin UI Visual Redesign

## Summary

全面升级 115 Gallery Worker 的 admin 面板视觉设计系统。保持 vanilla JS + 零构建工具的技术栈，通过重写 CSS 设计系统和增强 JS 交互体验，将现有的简陋 admin 界面提升为精致、专业的管理面板。

---

## Problem Frame

当前 admin 面板是功能导向的最小实现——卡片垂直堆叠、按钮无状态反馈、加载状态仅显示文字、通知内联嵌入页面。虽然功能完整，但视觉粗糙、交互缺乏反馈，给管理员的操作体验带来明显的廉价感。需要在不改变技术栈的前提下，通过设计系统升级显著提升面板的专业感和操作流畅度。

---

## Requirements

**设计 Token 升级**
- R1. 重新设计 CSS 自定义属性：更丰富的颜色层次（表面高亮、表面暗色、边框变体）、更精细的间距系统、阴影层级
- R2. 添加新的设计 token：`--shadow-sm`、`--shadow-md`、`--shadow-lg` 用于卡片和弹出层深度感
- R3. 改进排版层级：标题、正文、辅助文字的字号和字重区分

**组件样式升级**
- R4. 卡片组件：柔和阴影 + 细微边框 + hover 微抬效果 + 更大的圆角
- R5. 按钮组件：渐变背景 + 点击缩放反馈 + loading spinner 状态 + disabled 样式优化
- R6. 表单组件：focus 发光边框效果 + 更好的 label 样式 + 输入框内阴影
- R7. Alert 组件：保留但优化样式，用于非即时反馈场景

**交互体验增强**
- R8. Toast 通知系统：右上角弹出，自动 3 秒消失，支持 success/error/info 类型，替代大部分内联 alert
- R9. 骨架屏加载：替代 "Loading..." 和 "Checking..." 文字，使用 CSS 动画的占位块
- R10. 按钮 loading 状态：操作进行中时按钮显示 spinner 并禁用，防止重复点击
- R11. 状态指示器：连接状态的圆点添加脉冲动画（connected 绿色呼吸，disconnected 红色闪烁）

**布局优化**
- R12. 卡片间距从 1rem 增加到 1.5rem，增加视觉呼吸感
- R13. 卡片内 section 间距优化，标题与内容之间增加分隔线
- R14. Login 页面增加更精致的居中布局和品牌感

---

## Success Criteria

- 面板视觉质量从"功能原型"提升到"专业 admin 工具"水平
- 所有操作都有即时视觉反馈（按钮状态、toast 通知、加载动画）
- 不引入任何外部依赖或构建步骤
- 改动仅涉及 `public/style.css` 和 `public/app.js`，不修改后端代码

---

## Scope Boundaries

- 不引入前端框架（React/Vue/Svelte）
- 不引入 CSS 框架（Tailwind/Bootstrap）
- 不添加构建工具（Vite/Webpack/PostCSS）
- 不新增公开画廊浏览页面
- 不改变现有 API 交互逻辑
- 不修改 `index.html` 结构（除非必要）
- 不添加暗色/亮色主题切换

---

## Key Decisions

- 保持 vanilla JS + 零构建工具：当前项目规模（~530 行前端代码）不需要引入框架的复杂度
- Toast 替代内联 alert：即时操作反馈用 toast，持久状态信息保留 alert
- 骨架屏替代文字加载：提升感知性能和专业感
- 保持 7 卡片垂直布局：当前信息架构合理，不需要重构布局结构
