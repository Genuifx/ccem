!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Configuring CCEM Mode 2 sandbox permissions"
  nsExec::ExecToStack '"$SYSDIR\icacls.exe" "$INSTDIR" /grant:r *S-1-15-2-2:(OI)(CI)(RX) /L /Q'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    Abort "CCEM Mode 2 sandbox permissions could not be configured."
  ${EndIf}
!macroend
