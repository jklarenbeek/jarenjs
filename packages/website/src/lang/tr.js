//@ts-check
/**
 * The website's own words in Turkish (Türkçe): the ids of `siteMessagesEn`
 * (../messages.js). Loaded on demand, when a reader picks the language;
 * a published package's words travel in `@jarenjs/locales` instead.
 */

/** @type {Readonly<Record<string, string>>} */
export default Object.freeze({
  'site/lang/label': 'Dil',
  'site/play/downloaded': 'oturum indirildi',
  'site/play/download-unavailable': 'indirme burada kullanılamıyor',
  'site/play/open-unavailable': 'dosya açma burada kullanılamıyor',
  'site/play/not-a-session': '{name} bir Play oturumu değil',
  'site/play/not-a-session-unnamed': 'bu dosya bir Play oturumu değil',
  'site/play/imported': 'içe aktarıldı: {name}',
  'site/play/imported-unnamed': 'bir oturum içe aktarıldı',
  'site/play/unreadable': 'bu dosya okunamadı',
  'site/play/too-large': "paylaşım bağlantısı için çok büyük ({length} > {limit} karakter) — bunun yerine İndir'i kullanın",
  'site/play/link-ready': 'bağlantı hazır',
  'site/play/link-copied': 'bağlantı kopyalandı',
  'site/schema/invalid-json': 'Geçersiz JSON: {reason}',
  'site/ide/name-placeholder': 'Deney adı…',
  'site/ide/save': 'Kaydet',
  'site/ide/share': 'Paylaş',
  'site/ide/share-title': 'Bu projeyi geri yükleyen bir bağlantı kopyala',
  'site/ide/download': 'İndir',
  'site/ide/download-title': 'Tüm proje dosyalarını JSON olarak indir',
  'site/ide/app-json': "Uygulama JSON'u",
  'site/ide/app-json-title': 'Yalnızca uygulama belgesini JSON olarak indir',
  'site/ide/offline-zip': 'Çevrimdışı ZIP',
  'site/ide/load-title': 'Bu deneyi yükle',
  'site/ide/delete-title': 'Bu deneyi sil',
  'site/data/title': 'Veri',
  'site/flow/title': 'Akış',
});
