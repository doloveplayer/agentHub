import { Player } from "@lottiefiles/react-lottie-player";
import sleepAnim from "./nailong-sleep.json";
import workAnim from "./nailong-work.json";

export default function StatusDemo() {
  return (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
      <div style={{ textAlign: "center" }}>
        <Player
          autoplay
          loop
          src={sleepAnim}
          style={{ width: 180, height: 180 }}
        />
        <div>系统空闲中</div>
      </div>

      <div style={{ textAlign: "center" }}>
        <Player
          autoplay
          loop
          src={workAnim}
          style={{ width: 180, height: 180 }}
        />
        <div>系统工作中</div>
      </div>
    </div>
  );
}