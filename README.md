# amivoice-realtime

[AmiVoice Cloud Platform](https://acp.amivoice.com/) のリアルタイム音声認識（WebSocket インタフェース）に、音声を送って結果を受け取るクライアント。

**株式会社アドバンスト・メディアが提供する公式のライブラリではありません。** AmiVoice は同社の商標です。

- 依存パッケージなし
- ブラウザと Node のどちらでも動く
- マイクの取得を含まない。Float32 のサンプルを渡すだけなので、どこから音を取るかは呼び出し側が決める
- 資格情報をブラウザに置かせない作りで、トークンの発行はサーバー側の入口に分けてある

## 導入

```bash
npm install amivoice-realtime
```

## 使い方

### サーバー側 — トークンを発行する

接続には、ワンタイムの認証トークンが要る。発行にはサービス ID とパスワードが必要で、これはブラウザに置けない。サーバー側でトークンだけを返す。

```ts
// app/api/amivoice/token/route.ts （Next.js の例）
import { createTokenCache } from "amivoice-realtime/server";

const tokens = createTokenCache({
  serviceId: process.env.AMIVOICE_SERVICE_ID!,
  servicePassword: process.env.AMIVOICE_SERVICE_PASSWORD!,
  expiresInMs: 60_000,
});

export async function GET() {
  // 実際には、ここで呼び出し元の認証を必ず確かめること
  const { value } = await tokens.get();
  return Response.json({ token: value });
}
```

`createTokenCache` は、寿命の手前まで発行済みのトークンを使い回し、同時に来た要求を 1 本にまとめる。使い回したくなければ `issueAmiVoiceToken` を直に呼ぶ。

### ブラウザ側 — 音声を送る

```ts
import { AmiVoiceRealtimeClient } from "amivoice-realtime";

const client = new AmiVoiceRealtimeClient({
  // 関数で渡すと、再接続のたびに新しいトークンを取れる
  token: async () => {
    const res = await fetch("/api/amivoice/token");
    return (await res.json()).token;
  },
  onPartial: (text) => setInterim(text),
  onFinal: (text) => appendLine(text),
  onError: (error) => console.error(error),
});

await client.start();

// マイクから届いた Float32 のサンプルをそのまま渡す。
// リサンプルもパケットへの詰め替えもこの中で行う。
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const context = new AudioContext();
const source = context.createMediaStreamSource(stream);
const processor = context.createScriptProcessor(4096, 1, 1);
processor.onaudioprocess = (event) => {
  client.write(event.inputBuffer.getChannelData(0), context.sampleRate);
};
source.connect(processor);
processor.connect(context.destination);

// 終わるとき。最後の発話の確定結果が届くのを待ってから切る
await client.finish();
```

### Node で使う

`WebSocket` を持たない環境では、実装を渡す。

```ts
import WebSocket from "ws";
import { AmiVoiceRealtimeClient } from "amivoice-realtime";

const client = new AmiVoiceRealtimeClient({
  token: "...",
  webSocket: (url) => new WebSocket(url) as never,
});
```

## 単語登録

固有名詞や現場の言い回しは、`s` コマンドに載せて認識させられる。

```ts
import { formatProfileWords } from "amivoice-realtime";

const profileWords = formatProfileWords([
  { written: "個浴槽", spoken: "こよくそう", wordClass: "固有名詞" },
  { written: "臥床", spoken: "がしょう" },
]);

new AmiVoiceRealtimeClient({ token, profileWords, profileId: "your-profile" });
```

## 設定

| 名前 | 既定 | 説明 |
| ---- | ---- | ---- |
| `token` | （必須） | 認証トークン、またはそれを返す関数 |
| `grammar` | `-a-general` | 認識エンジン |
| `codec` | `MSB16K` | 音声形式。16 kHz のビッグエンディアン |
| `sampleRate` | `16000` | 送出するサンプリングレート。`codec` に合わせる |
| `sendIntervalMs` | `100` | 1 パケットに載せる音声の長さ |
| `resultUpdatedIntervalMs` | `1000` | 途中経過を返す間隔 |
| `profileId` / `profileWords` | — | マイ辞書と単語登録 |
| `reconnect` | 最大 5 回 | 再接続の設定。`false` で切る |
| `finishTimeoutMs` | `3000` | `finish()` で `e` の応答を待つ時間 |
| `url` | `wss://acp-api.amivoice.com/v1/` | 接続先 |
| `webSocket` | グローバル | `WebSocket` の実装 |
| `startParams` | — | `s` コマンドに足すパラメータ |

## 気をつけている点

実際に運用していて踏んだところを、そのまま作りに入れてある。

- **`s` / `p` / `e` の応答に本体が付いていたらエラーにする。** AmiVoice はこれらの応答を、成功なら本体なし、失敗ならエラーメッセージ付きで返す。認証に失敗したことに気づけるのはここだけで、見落とすと、音声を送り続けたまま無音の結果を待つことになる
- **`s` の成功応答が来るまで音声を送らない。** 送っても捨てられる
- **繋がっていない間に渡された音声は捨てる。** 溜めて後から送ると、過去の音声が今の発話として届く
- **`finish()` は `e` の応答を待ってから切る。** すぐ切ると言い終わりが落ちる
- **音声はビッグエンディアンで送る。** `MSB16K` は Most Significant Byte first。取り違えると雑音として認識される

## 低い層だけ使う

パケットの組み立てと解析は、それぞれ単体で使える。

```ts
import {
  buildStartCommand,
  buildAudioPacket,
  floatToInt16,
  parseResultBody,
  resample,
  splitPacket,
} from "amivoice-realtime";
```

## ライセンス

MIT
