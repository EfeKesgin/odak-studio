; Odak Studio'yu Windows Gezgini'nin "Birlikte aç" listesine ekler.
; Varsayılan uygulamalar DEĞİŞTİRİLMEZ: yalnızca her uzantının
; OpenWithProgids listesine bir giriş yazılır. Kaldırınca hepsi silinir.
; Uzantılar src/shared.js'teki video/görsel listeleriyle aynı olmalı
; (test/static-check.test.js denetler).

!define ODAK_PROGID "OdakStudio.Media"

!macro odakOpenWith EXT
  WriteRegStr SHCTX "Software\Classes\${EXT}\OpenWithProgids" "${ODAK_PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" "${EXT}" ""
!macroend

!macro odakRemoveOpenWith EXT
  DeleteRegValue SHCTX "Software\Classes\${EXT}\OpenWithProgids" "${ODAK_PROGID}"
  DeleteRegKey /ifempty SHCTX "Software\Classes\${EXT}\OpenWithProgids"
!macroend

!macro odakForEachExtension MACRO
  !insertmacro ${MACRO} ".mp4"
  !insertmacro ${MACRO} ".m4v"
  !insertmacro ${MACRO} ".mov"
  !insertmacro ${MACRO} ".mkv"
  !insertmacro ${MACRO} ".webm"
  !insertmacro ${MACRO} ".avi"
  !insertmacro ${MACRO} ".wmv"
  !insertmacro ${MACRO} ".flv"
  !insertmacro ${MACRO} ".mpg"
  !insertmacro ${MACRO} ".mpeg"
  !insertmacro ${MACRO} ".m2ts"
  !insertmacro ${MACRO} ".mts"
  !insertmacro ${MACRO} ".ts"
  !insertmacro ${MACRO} ".3gp"
  !insertmacro ${MACRO} ".ogv"
  !insertmacro ${MACRO} ".vob"
  !insertmacro ${MACRO} ".jpg"
  !insertmacro ${MACRO} ".jpeg"
  !insertmacro ${MACRO} ".png"
  !insertmacro ${MACRO} ".webp"
  !insertmacro ${MACRO} ".avif"
  !insertmacro ${MACRO} ".tif"
  !insertmacro ${MACRO} ".tiff"
  !insertmacro ${MACRO} ".gif"
!macroend

; ── Gezgin sağ tık: "Odak ile küçült" ─────────────────────────────────
; Video dosyalarının sağ tık menüsüne bir alt menü eklenir; her seçenek
; uygulamayı "--compress=<ayar>" ile çağırır (electron/quick-compress.js).
; SystemFileAssociations kullanılır: dosya ilişkileri değişmez. Windows 11'de
; "Diğer seçenekleri göster" altında görünür. Uzantılar src/shared.js'teki
; video listesiyle aynı olmalı (test/static-check.test.js denetler).
!define ODAK_COMPRESS_KEY "shell\OdakStudio.Compress"

!macro odakCompressMenu EXT
  !define /redef ODAK_CM "Software\Classes\SystemFileAssociations\${EXT}\${ODAK_COMPRESS_KEY}"
  WriteRegStr SHCTX "${ODAK_CM}" "MUIVerb" "$R7"
  WriteRegStr SHCTX "${ODAK_CM}" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "${ODAK_CM}" "SubCommands" ""
  WriteRegStr SHCTX "${ODAK_CM}\shell\0quality" "MUIVerb" "$R9"
  WriteRegStr SHCTX "${ODAK_CM}\shell\0quality\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --compress=quality "%1"'
  WriteRegStr SHCTX "${ODAK_CM}\shell\1discord" "MUIVerb" "Discord · 10 MB"
  WriteRegStr SHCTX "${ODAK_CM}\shell\1discord\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --compress=discord "%1"'
  WriteRegStr SHCTX "${ODAK_CM}\shell\2whatsapp" "MUIVerb" "WhatsApp · 16 MB"
  WriteRegStr SHCTX "${ODAK_CM}\shell\2whatsapp\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --compress=whatsapp "%1"'
  WriteRegStr SHCTX "${ODAK_CM}\shell\3email" "MUIVerb" "$R8"
  WriteRegStr SHCTX "${ODAK_CM}\shell\3email\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --compress=email "%1"'
!macroend

!macro odakRemoveCompressMenu EXT
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\${EXT}\${ODAK_COMPRESS_KEY}"
!macroend

!macro odakForEachVideoExtension VMACRO
  !insertmacro ${VMACRO} ".mp4"
  !insertmacro ${VMACRO} ".m4v"
  !insertmacro ${VMACRO} ".mov"
  !insertmacro ${VMACRO} ".mkv"
  !insertmacro ${VMACRO} ".webm"
  !insertmacro ${VMACRO} ".avi"
  !insertmacro ${VMACRO} ".wmv"
  !insertmacro ${VMACRO} ".flv"
  !insertmacro ${VMACRO} ".mpg"
  !insertmacro ${VMACRO} ".mpeg"
  !insertmacro ${VMACRO} ".m2ts"
  !insertmacro ${VMACRO} ".mts"
  !insertmacro ${VMACRO} ".ts"
  !insertmacro ${VMACRO} ".3gp"
  !insertmacro ${VMACRO} ".ogv"
  !insertmacro ${VMACRO} ".vob"
!macroend

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\${ODAK_PROGID}" "" "Odak Studio"
  WriteRegStr SHCTX "Software\Classes\${ODAK_PROGID}" "FriendlyTypeName" "Odak Studio"
  WriteRegStr SHCTX "Software\Classes\${ODAK_PROGID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\${ODAK_PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Odak Studio"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  !insertmacro odakForEachExtension odakOpenWith
  ; Menü metni Windows arayüz diline göre: Türkçe (1055) ya da İngilizce.
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  StrCpy $R7 "Shrink with Odak"
  StrCpy $R8 "Email · 25 MB"
  StrCpy $R9 "Keep quality (same resolution)"
  IntCmp $0 1055 0 +4 +4
    StrCpy $R7 "Odak ile küçült"
    StrCpy $R8 "E-posta · 25 MB"
    StrCpy $R9 "Kaliteyi koru (çözünürlük aynı)"
  !insertmacro odakForEachVideoExtension odakCompressMenu
  ; Gezgin'e dosya ilişkilerinin değiştiğini bildir.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro odakForEachExtension odakRemoveOpenWith
  !insertmacro odakForEachVideoExtension odakRemoveCompressMenu
  DeleteRegKey SHCTX "Software\Classes\${ODAK_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
