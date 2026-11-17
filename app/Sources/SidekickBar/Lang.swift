import Foundation

/// The interface language, the same one the daemon and the panel use (src/i18n.ts): every string a
/// person sees is written in both, `L("中文", "English")`. The daemon resolves the setting (auto follows
/// the system) and reports it in /api/state; until it answers, the system language decides.
enum UILang {
    private(set) static var current: String = systemDefault()

    static func systemDefault() -> String {
        (Locale.preferredLanguages.first ?? "en").lowercased().hasPrefix("zh") ? "zh" : "en"
    }

    /// From /api/state. Returns true when the language changed, so menus can be rebuilt.
    @discardableResult
    static func update(from daemon: String?) -> Bool {
        guard let lang = daemon, lang == "zh" || lang == "en", lang != current else { return false }
        current = lang
        return true
    }
}

/// The string for the interface language.
func L(_ zh: String, _ en: String) -> String {
    UILang.current == "en" ? en : zh
}
