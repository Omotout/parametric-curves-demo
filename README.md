# Parametric Curves Demo (UE5 Spline Component Inspired)

コンピュータグラフィクス論 第1回 課題のデモ。

3つの曲線基底 (Catmull-Rom / Cubic Bezier / Cubic Hermite) を切り替えながら、
同じ制御点配置で形状を比較できる UE5 Spline Component 風スプラインエディタ。

## 実行方法

ローカルで動かす場合 (ES modules を使うのでローカルサーバ必須):

```powershell
python -m http.server 8000
```

ブラウザで `http://localhost:8000` を開く。

## 操作

- **右クリック** + マウス: 視点回転 (カーソルがロックされる)
- **右クリック + WASD/QE/Space**: 飛行移動
- **マウスホイール**: 前後ドリー
- **左クリック**: 制御点 / ハンドル / 辺の選択
- **W / E / R**: 移動 / 回転 / 拡大ギズモ
- **Alt + ギズモドラッグ**: 制御点の複製 (端点ならスプライン延長)
- **ダブルクリック (スプライン上)**: 新規制御点の挿入
- **Delete**: 選択中の制御点削除
- **Ctrl+Z / Ctrl+Y**: Undo / Redo
- **F**: 選択オブジェクトにフォーカス
- **Esc**: 選択解除

## 実装

- `js/curves.js`: 3つの曲線アルゴリズム (バーンスタイン基底 / Catmull-Rom / エルミート基底)
- `js/demo-spline.js`: シーン・編集 UI
- `js/ue5-controls.js`: UE5 風カメラ・ギズモ・Undo
- `js/main.js`: エントリポイント

## 依存

- three.js (CDN 経由、importmap で読込)
- three/addons/controls/TransformControls.js (ギズモ UI、曲線アルゴリズムは自前)
