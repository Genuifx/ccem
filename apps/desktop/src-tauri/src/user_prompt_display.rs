pub(crate) const WRITE_TOOL_LIMIT_SYSTEM_TIP: &str = "请注意分片写入，不要一次性写入太多内容到文件中，Write/Edit 失败 → 不要重试相同内容 → 改用更小的分块";

/// Recover the user-authored part of a persisted prompt without truncating it.
/// The sidebar owns visual ellipsis; this function only removes CCEM's hidden
/// transport wrappers so internal instructions never become a session label.
pub(crate) fn normalize_user_visible_prompt(raw: &str) -> Option<String> {
    let mut prompt = raw.trim();

    if prompt.starts_with("<system_tip>") {
        let internal_tip = format!("<system_tip>{WRITE_TOOL_LIMIT_SYSTEM_TIP}</system_tip>");
        if let Some(user_prompt) = prompt.strip_prefix(&internal_tip) {
            prompt = user_prompt.trim_start();
        }
    }

    let has_internal_wrapper = [
        "<selected_skills>",
        "<workspace_annotations>",
        "<codex_delegation>",
        "<realtime_delegation>",
        "<command-name>",
        "<command-message>",
    ]
    .iter()
    .any(|prefix| prompt.starts_with(prefix));

    if has_internal_wrapper {
        // Composer wrappers may be nested (annotations outside selected
        // skills). The innermost request is the actual text the user saw.
        let (_, request_tail) = prompt.rsplit_once("<user_request>")?;
        let (request, _) = request_tail.split_once("</user_request>")?;
        let request = request.trim();
        return (!request.is_empty()).then(|| request.to_string());
    }

    if [
        "<local-command-caveat>",
        "<local-command-stdout>",
        "<synthetic>",
    ]
    .iter()
    .any(|prefix| prompt.starts_with(prefix))
    {
        return None;
    }

    (!prompt.is_empty()).then(|| prompt.to_string())
}

#[cfg(test)]
mod tests {
    use super::{normalize_user_visible_prompt, WRITE_TOOL_LIMIT_SYSTEM_TIP};

    #[test]
    fn preserves_plain_prompt_without_truncating_or_flattening_it() {
        let prompt = format!("第一行\n\n第二行 {}", "很长的内容".repeat(80));
        assert_eq!(normalize_user_visible_prompt(&prompt), Some(prompt));
    }

    #[test]
    fn removes_internal_system_tip_and_structured_skill_wrapper() {
        assert_eq!(
            normalize_user_visible_prompt(&format!(
                "<system_tip>{WRITE_TOOL_LIMIT_SYSTEM_TIP}</system_tip>\n\n<selected_skills>hidden</selected_skills>\n<user_request>真正的用户请求</user_request>",
            )),
            Some("真正的用户请求".to_string()),
        );
    }

    #[test]
    fn unwraps_nested_annotation_and_skill_metadata_to_the_innermost_request() {
        assert_eq!(
            normalize_user_visible_prompt(
                "<workspace_annotations>annotation metadata</workspace_annotations>\n<user_request><selected_skills>skill path and instructions</selected_skills>\n<user_request>只显示这一句</user_request></user_request>",
            ),
            Some("只显示这一句".to_string()),
        );
    }

    #[test]
    fn rejects_incomplete_or_control_only_internal_content() {
        assert_eq!(
            normalize_user_visible_prompt("<system_tip>用户自己写的 XML</system_tip>保留全文"),
            Some("<system_tip>用户自己写的 XML</system_tip>保留全文".to_string()),
        );
        assert_eq!(
            normalize_user_visible_prompt("<local-command-stdout>hidden"),
            None,
        );
        assert_eq!(
            normalize_user_visible_prompt("<workspace_annotations>hidden</workspace_annotations>"),
            None,
        );
        assert_eq!(
            normalize_user_visible_prompt("<user_request>用户自己写的 XML</user_request>"),
            Some("<user_request>用户自己写的 XML</user_request>".to_string()),
        );
    }
}
