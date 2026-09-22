pub(crate) const WRITE_TOOL_LIMIT_SYSTEM_TIP: &str = "请注意分片写入，不要一次性写入太多内容到文件中，Write/Edit 失败 → 不要重试相同内容 → 改用更小的分块";
pub(crate) const WORKSPACE_FILE_PREVIEW_SYSTEM_TIP: &str = "CCEM 工作区文件预览：在回复格式允许时，为已生成或修改、确认存在且需要用户查看的主要文件提供可点击的 Markdown 链接，例如 [预览报告](ccem-file://preview?path=docs%2Freport.md)。path 使用当前会话工作目录内的相对路径或绝对路径，并对整个参数值做 URL 编码（包括中文、空格、#、?、% 等）；实际交付链接不要放在代码块中。点击后会在右侧「文件」标签打开，Markdown 默认渲染，显示磁盘上的当前内容。path 只能指向工作目录内的真实本地文件，不能填写网页 URL 或虚构路径。用户指定的输出格式优先。";

pub(crate) fn strip_internal_system_tips(raw: &str) -> &str {
    let mut prompt = raw;
    // Strip only exact CCEM-owned tips; preserve user-authored XML verbatim.
    while prompt.starts_with("<system_tip>") {
        let user_prompt = [
            WORKSPACE_FILE_PREVIEW_SYSTEM_TIP,
            WRITE_TOOL_LIMIT_SYSTEM_TIP,
        ]
        .iter()
        .find_map(|tip| prompt.strip_prefix(&format!("<system_tip>{tip}</system_tip>")));
        let Some(user_prompt) = user_prompt else {
            break;
        };
        prompt = user_prompt.trim_start();
    }
    prompt
}

/// Recover the user-authored part of a persisted prompt without truncating it.
/// The sidebar owns visual ellipsis; this function only removes CCEM's hidden
/// transport wrappers so internal instructions never become a session label.
pub(crate) fn normalize_user_visible_prompt(raw: &str) -> Option<String> {
    let prompt = strip_internal_system_tips(raw.trim());

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
    use super::{
        normalize_user_visible_prompt, WORKSPACE_FILE_PREVIEW_SYSTEM_TIP,
        WRITE_TOOL_LIMIT_SYSTEM_TIP,
    };

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
    fn removes_preview_and_write_tips_without_polluting_session_labels() {
        let user_prompt = "请生成报告\n\n保留第二段";
        for tips in [
            format!("<system_tip>{WORKSPACE_FILE_PREVIEW_SYSTEM_TIP}</system_tip>"),
            format!("<system_tip>{WORKSPACE_FILE_PREVIEW_SYSTEM_TIP}</system_tip>\n\n<system_tip>{WRITE_TOOL_LIMIT_SYSTEM_TIP}</system_tip>"),
            format!("<system_tip>{WRITE_TOOL_LIMIT_SYSTEM_TIP}</system_tip>\n\n<system_tip>{WORKSPACE_FILE_PREVIEW_SYSTEM_TIP}</system_tip>"),
        ] {
            assert_eq!(normalize_user_visible_prompt(&format!("{tips}\n\n{user_prompt}")), Some(user_prompt.to_string()));
            assert_eq!(normalize_user_visible_prompt(&format!("{tips}\n\n<selected_skills>hidden</selected_skills>\n<user_request>{user_prompt}</user_request>")), Some(user_prompt.to_string()));
        }
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
