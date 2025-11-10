# Nesting Test Suite - Version 4

This file tests the context-based nesting implementation.

---

## Level 1: Simple Patterns (No Nesting)

These should work in both v3 and v4:

- *simple italic*
- _simple underline_
- **simple bold**
- __simple strong__
- ~~simple strikethrough~~
- ==simple highlight==
- ++simple reference|simple note++
- !!simple marginal|simple note!!

Expected: All patterns highlighted with correct colors from Styles.css.

---

## Level 2: Basic Nesting (One Level Deep)

### Test 2.1: Italic containing other patterns

*italic with ++sidenote|note++*

*italic with ==highlight==*

*italic with **bold***

*italic with _underline_*

*italic with ~~strike~~*

Expected: 
- Outer italic = gold
- Inner patterns maintain their colors
- All properly scoped

### Test 2.2: Sidenote containing other patterns

++reference|note with *italic*++

++reference|note with _underline_++

++reference|note with **bold**++

++reference|note with ==highlight==++

Expected:
- Reference = purple
- Note = orange
- Nested patterns colored correctly within orange note

### Test 2.3: Bold containing other patterns

**bold with *italic***

**bold with ==highlight==**

**bold with ++sidenote|note++**

Expected: Bold (purple) containing other colored patterns

### Test 2.4: Highlight containing other patterns

==highlight with *italic*==

==highlight with **bold**==

==highlight with _underline_==

Expected: Orange foreground for all text

---

## Level 3: Complex Real-World Examples

### Test 3.1: User's Original Example

*wie eine ++stillende Mutter|...*weil sie...*...++*

Expected:
1. Outer `*...*` = gold italic
2. Middle `++...++` = purple ref, orange note
3. Inside note `*weil sie*` = gold italic
4. After sidenote, back to outer italic (gold)

### Test 3.2: Multiple Nested Emphasis in Sidenote

++Reference text|Note with *italic* and _underline_ and **bold** and ~~strike~~++

Expected:
- Reference = purple
- Note = orange background
- *italic* = gold
- _underline_ = green
- **bold** = purple
- ~~strike~~ = red/pink

### Test 3.3: Deeply Nested Pattern

**Bold with ==highlighted ++sidenote|with *italic* inside++==**

Expected:
1. Outer `**...**` = purple bold
2. `==...==` = orange foreground
3. `++...++` = purple ref, orange note
4. `*italic*` = gold

### Test 3.4: Marginal Note in Italic

*italic with !!marginal|note with _underline_ and **bold**!!*

Expected:
1. Outer italic = gold
2. Marginal reference = orange
3. Marginal note = purple
4. Inside note: underline = green, bold = purple

---

## Level 4: Edge Cases

### Test 4.1: Adjacent Patterns

*italic* **bold** ==highlight== ~~strike~~

Expected: Each pattern separately highlighted

### Test 4.2: Overlapping Delimiters (Should NOT Work)

*italic **bold* and more**

Expected: May not highlight correctly - invalid markdown

### Test 4.3: Unclosed Pattern (Should Consume Rest)

*italic text without closing
More text here
Even more

Expected: All text remains italic until EOF or closing `*`

### Test 4.4: Empty Patterns

** **
__ __
* *
_ _

Expected: May or may not highlight (edge case)

### Test 4.5: Nested Same Pattern (Should NOT Work by Design)

*italic with *more italic**

++sidenote ++nested sidenote++++

Expected: Won't highlight correctly - recursion prevention working

---

## Level 5: Color Verification (Styles.css Mapping)

All patterns should use colors from Styles.css:

| Pattern | Expected Color (Light) | Hex Code | CSS Variable |
|---------|------------------------|----------|--------------|
| ==highlight== | Orange foreground | #ff5a1b | lm-accent2 |
| *italic* | Gold | #ffb400 | lm-accent3 |
| _underline_ | Green | #00c76a | lm-accent4 |
| **bold** | Purple | #6f4dff | lm-accent6 |
| __strong__ | Cyan | #00aee8 | lm-accent5 |
| ~~strike~~ | Pink/Red | #ff0f6e | lm-accent1 |
| ++ref\|note++ | Purple/Orange | Various | sn-color-* |

### Visual Test

*This text should be GOLD (#ffb400)*

_This text should be GREEN (#00c76a)_

**This text should be PURPLE (#6f4dff)**

__This text should be CYAN (#00aee8)__

~~This text should be PINK/RED (#ff0f6e)~~

==This text should be ORANGE foreground (#ff5a1b)==

---

## Level 6: Performance Tests

### Test 6.1: Many Patterns in One Line

*italic* with **bold** and _underline_ and __strong__ and ==highlight== and ~~strike~~ and ++sidenote|note++ all in one line.

Expected: All patterns highlighted correctly

### Test 6.2: Long Nested Pattern

*This is a very long italic text that contains a ++very long sidenote reference|and an even longer note content that includes *nested italic* and _nested underline_ and **nested bold** patterns throughout the entire note content++ and then continues with more italic text after the sidenote closes.*

Expected: All nesting maintained correctly

### Test 6.3: Multiple Levels Deep

**Bold containing ==highlight containing ++sidenote|note with *italic* and _underline_++==**

Expected: 4 levels of nesting, all colored correctly

---

## Level 7: Block Patterns (Should Still Work)

### Test 7.1: Admonitions

!!! note "Test Note"
    This is a note with *italic* and **bold**.

!!! warning "Test Warning"
    This is a warning with ==highlight== and ++sidenote|note++.

Expected: Block highlighting + inline nesting inside

### Test 7.2: Table of Contents

[[TOC]]

Expected: Purple bold "TOC" text

### Test 7.3: Checkboxes

- [ ] Unchecked item with *italic*
- [x] Checked item with **bold**
- [X] Another checked with ==highlight==

Expected: Checkboxes work + inline nesting

---

## Success Criteria

✅ All Level 2 tests highlight correctly (basic nesting)
✅ User's original example (Test 3.1) works perfectly
✅ No recursion errors in console
✅ Colors match Styles.css specification
✅ Same-pattern nesting fails gracefully (no crash)
✅ Performance acceptable for typical documents

---

## Testing Procedure

1. **Install v4**: Run `.\Install.ps1`
2. **Clear cache**: `Remove-Item "$env:APPDATA\Sublime Text\Cache" -Recurse -Force`
3. **Restart Sublime**: Completely close and reopen
4. **Open this file**: `NESTING_TESTS.md`
5. **Select syntax**: "Markdown Extended" (bottom-right)
6. **Select color scheme**: "Markdown Extended" or "Markdown Extended Dark"
7. **Verify each test**: Check colors match expected values
8. **Check console**: No errors (Ctrl+`)
9. **Test scope names**: Ctrl+Alt+Shift+P to see scope at cursor

---

## Debugging

If tests fail:

1. **Verify version**: File should start with `version: 4`
2. **Check syntax selection**: Bottom-right must say "Markdown Extended"
3. **Verify color scheme**: Must be "Markdown Extended" (not base Markdown)
4. **Console errors**: Ctrl+` to see syntax errors
5. **Scope inspection**: Ctrl+Alt+Shift+P shows applied scopes
6. **Reinstall**: `.\Install.ps1` and restart Sublime

---

**This comprehensive test suite validates v4's context-based nesting implementation!**
