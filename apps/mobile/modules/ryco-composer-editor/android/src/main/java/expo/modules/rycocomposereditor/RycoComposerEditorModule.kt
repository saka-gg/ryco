package expo.modules.rycocomposereditor

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class RycoComposerEditorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RycoComposerEditor")

    View(RycoComposerEditorView::class) {
      Prop("controlledDocumentJson") { view: RycoComposerEditorView, documentJson: String ->
        view.setControlledDocumentJson(documentJson)
      }
      Prop("themeJson") { view: RycoComposerEditorView, themeJson: String ->
        view.setThemeJson(themeJson)
      }
      Prop("placeholder") { view: RycoComposerEditorView, placeholder: String ->
        view.setPlaceholder(placeholder)
      }
      Prop("textAccessibilityLabel") { view: RycoComposerEditorView, label: String? ->
        view.setTextAccessibilityLabel(label)
      }
      Prop("fontFamily") { view: RycoComposerEditorView, fontFamily: String ->
        view.setFontFamily(fontFamily)
      }
      Prop("fontSize") { view: RycoComposerEditorView, fontSize: Double ->
        view.setFontSize(fontSize.toFloat())
      }
      Prop("lineHeight") { view: RycoComposerEditorView, lineHeight: Double ->
        view.setLineHeight(lineHeight.toFloat())
      }
      Prop("contentInsetVertical") { view: RycoComposerEditorView, contentInsetVertical: Double ->
        view.setContentInsetVertical(contentInsetVertical.toInt())
      }

      Prop("singleLineCentered") { view: RycoComposerEditorView, singleLineCentered: Boolean ->
        view.setSingleLineCentered(singleLineCentered)
      }
      Prop("editable") { view: RycoComposerEditorView, editable: Boolean ->
        view.setEditable(editable)
      }
      Prop("scrollEnabled") { view: RycoComposerEditorView, scrollEnabled: Boolean ->
        view.setScrollEnabled(scrollEnabled)
      }
      Prop("autoFocus") { view: RycoComposerEditorView, autoFocus: Boolean ->
        view.setAutoFocus(autoFocus)
      }
      Prop("autoCorrect") { view: RycoComposerEditorView, autoCorrect: Boolean ->
        view.setAutoCorrect(autoCorrect)
      }
      Prop("spellCheck") { view: RycoComposerEditorView, spellCheck: Boolean ->
        view.setSpellCheck(spellCheck)
      }

      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerPasteImages",
        "onComposerContentSizeChange",
      )

      AsyncFunction("focus") { view: RycoComposerEditorView ->
        view.focusEditor()
      }
      AsyncFunction("blur") { view: RycoComposerEditorView ->
        view.blurEditor()
      }
      AsyncFunction("setSelection") { view: RycoComposerEditorView, start: Int, end: Int ->
        view.setSelection(start, end)
      }
    }
  }
}
