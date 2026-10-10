use std::collections::HashMap;

use napi_derive::napi;

#[napi]
pub struct PreparedDictionary {
    term_count: usize,
    term_indexes_by_lowercase: HashMap<String, Vec<usize>>,
}

#[napi]
impl PreparedDictionary {
    #[napi(constructor)]
    pub fn new(terms: Vec<String>) -> Self {
        let term_count = terms.len();
        let mut term_indexes_by_lowercase: HashMap<String, Vec<usize>> = HashMap::new();

        for (term_index, term) in terms.iter().enumerate() {
            if term.len() < 3 || !term.is_ascii() || !term.bytes().all(is_word_byte) {
                continue;
            }
            term_indexes_by_lowercase
                .entry(term.to_ascii_lowercase())
                .or_default()
                .push(term_index);
        }

        Self {
            term_count,
            term_indexes_by_lowercase,
        }
    }

    #[napi]
    pub fn scan(&self, text: String) -> Vec<u32> {
        self.scan_inner(&text)
    }
}

#[napi(js_name = "scanAsciiTerms")]
pub fn scan_ascii_terms(text: String, terms: Vec<String>) -> Vec<u32> {
    PreparedDictionary::new(terms).scan_inner(&text)
}

impl PreparedDictionary {
    fn scan_inner(&self, text: &str) -> Vec<u32> {
        let mut first_matches = vec![None; self.term_count];
        let bytes = text.as_bytes();
        let mut byte_index = 0;
        let mut utf16_index = 0;

        while byte_index < bytes.len() {
            if !is_word_byte(bytes[byte_index]) {
                let character = text[byte_index..]
                    .chars()
                    .next()
                    .expect("byte index is before the end of the string");
                byte_index += character.len_utf8();
                utf16_index += character.len_utf16();
                continue;
            }

            let token_start = byte_index;
            let token_start_utf16 = utf16_index;
            while byte_index < bytes.len() && is_word_byte(bytes[byte_index]) {
                byte_index += 1;
                utf16_index += 1;
            }

            let token = &text[token_start..byte_index];
            if let Some(term_indexes) = self
                .term_indexes_by_lowercase
                .get(&token.to_ascii_lowercase())
            {
                let token_length = (utf16_index - token_start_utf16) as u32;
                for term_index in term_indexes {
                    let first_match = &mut first_matches[*term_index];
                    if first_match.is_none() {
                        *first_match = Some((token_start_utf16 as u32, token_length));
                    }
                }
            }
        }

        let mut flattened_matches = Vec::new();
        for (term_index, first_match) in first_matches.into_iter().enumerate() {
            if let Some((start, length)) = first_match {
                flattened_matches.extend([term_index as u32, start, length]);
            }
        }
        flattened_matches
    }
}

#[inline]
fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

#[cfg(test)]
mod tests {
    use super::PreparedDictionary;

    #[test]
    fn preserves_dictionary_order_first_match_and_ascii_word_boundaries() {
        let dictionary = PreparedDictionary::new(vec![
            "beta".to_string(),
            "widget".to_string(),
            "alpha".to_string(),
        ]);

        assert_eq!(
            dictionary.scan("xwidget widgetized (WIDGET), alpha then beta".to_string()),
            vec![0, 40, 4, 1, 20, 6, 2, 29, 5],
        );
    }

    #[test]
    fn reports_javascript_utf16_offsets_after_non_ascii_text() {
        let dictionary = PreparedDictionary::new(vec!["widget".to_string()]);
        let text = "🧪 widget";

        assert_eq!(dictionary.scan(text.to_string()), vec![0, 3, 6]);
    }
}