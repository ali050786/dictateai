{
  "targets": [
    {
      "target_name": "text_injection",
      "sources": ["TextInjectionAddon.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "xcode_settings": {
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-ObjC++"],
        "OTHER_LDFLAGS": [
          "-framework ApplicationServices",
          "-framework AppKit",
          "-framework Carbon"
        ],
        "MACOSX_DEPLOYMENT_TARGET": "13.0"
      }
    }
  ]
}
