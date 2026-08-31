; NSIS include for AI Studio
; NSIS 3.x Unicode mode handles CJK font rendering correctly by default
; SetFont is not valid inside a Function in NSIS 3.0.4.1, so we omit it.

!macro customInit
  ; NSIS 3.x Unicode already supports CJK characters properly.
  ; No custom font setup required.
!macroend
