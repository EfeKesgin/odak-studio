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

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\${ODAK_PROGID}" "" "Odak Studio"
  WriteRegStr SHCTX "Software\Classes\${ODAK_PROGID}" "FriendlyTypeName" "Odak Studio"
  WriteRegStr SHCTX "Software\Classes\${ODAK_PROGID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\${ODAK_PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Odak Studio"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  !insertmacro odakForEachExtension odakOpenWith
  ; Gezgin'e dosya ilişkilerinin değiştiğini bildir.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro odakForEachExtension odakRemoveOpenWith
  DeleteRegKey SHCTX "Software\Classes\${ODAK_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
