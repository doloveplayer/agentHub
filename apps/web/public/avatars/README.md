# 奶龙 Lottie 动画包

这个压缩包中包含两个可直接用于前端的 Lottie JSON 动画：

- `nailong-sleep.json`：睡眠/空闲状态
- `nailong-work.json`：工作/在线状态

## 说明
这是**图像型 Lottie**（JSON 内嵌 PNG 图片并做轻微动效），
优点是你可以直接在 `lottie-react` 里使用；
缺点是它不是设计师在 After Effects 里导出的纯矢量 Lottie，
所以体积会比专业矢量版略大一些。

## 安装
```bash
npm install lottie-react
```

## React 用法
```jsx
import { Player } from "@lottiefiles/react-lottie-player";
import sleepAnim from "./nailong-sleep.json";
import workAnim from "./nailong-work.json";

<Player autoplay loop src={sleepAnim} style={{ width: 180, height: 180 }} />
<Player autoplay loop src={workAnim} style={{ width: 180, height: 180 }} />
```

或者你也可以参考 `StatusDemo.jsx`。