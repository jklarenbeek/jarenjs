//@ts-check
/**
 * The website's own words in Japanese (日本語): the ids of `siteMessagesEn`
 * (../messages.js). Loaded on demand, when a reader picks the language;
 * a published package's words travel in `@jarenjs/locales` instead.
 */

/** @type {Readonly<Record<string, string>>} */
export default Object.freeze({
  'site/lang/label': '言語',
  'site/play/downloaded': 'セッションをダウンロードしました',
  'site/play/download-unavailable': 'ここではダウンロードできません',
  'site/play/open-unavailable': 'ここではファイルを開けません',
  'site/play/not-a-session': '{name} は Play のセッションではありません',
  'site/play/not-a-session-unnamed': 'そのファイルは Play のセッションではありません',
  'site/play/imported': '{name} をインポートしました',
  'site/play/imported-unnamed': 'セッションをインポートしました',
  'site/play/unreadable': 'そのファイルを読み取れませんでした',
  'site/play/too-large': '共有リンクには大きすぎます（{length} > {limit} 文字） — 代わりにダウンロードを使用してください',
  'site/play/link-ready': 'リンクの準備ができました',
  'site/play/link-copied': 'リンクをコピーしました',
  'site/schema/invalid-json': '無効な JSON: {reason}',
  'site/ide/name-placeholder': '実験名を入力…',
  'site/ide/save': '保存',
  'site/ide/share': '共有',
  'site/ide/share-title': 'このプロジェクトを復元するリンクをコピーします',
  'site/ide/download': 'ダウンロード',
  'site/ide/download-title': 'プロジェクトのすべてのファイルを JSON としてダウンロードします',
  'site/ide/app-json': 'アプリ JSON',
  'site/ide/app-json-title': 'アプリドキュメントだけを JSON としてダウンロードします',
  'site/ide/offline-zip': 'オフライン ZIP',
  'site/ide/load-title': 'この実験を読み込みます',
  'site/ide/delete-title': 'この実験を削除します',
  'site/data/title': 'データ',
  'site/flow/title': 'フロー',
});
