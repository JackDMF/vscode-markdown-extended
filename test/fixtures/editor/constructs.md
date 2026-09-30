---
title: Every construct Markdown Extended Pro renders
tags: [editor, round-trip]
---

# Constructs

[[toc]]

A plain paragraph that is hard-wrapped by hand, so the round trip has a softbreak to
carry, with *emphasis*, _underscore emphasis_, **strong**, __underscore strong__ and
`inline code`, a [relative link](other.md#anchor "with a title") and a hard break\
right here.

Setext heading
--------------

## Admonitions and containers

!!! note "A titled note"
    The body of an admonition is indented.

::: warning
A container with a class name.
:::

!!! tip
    An admonition without a title, its body a list:

    - one
    - two

:::: note-box wide
A container holding a list and a container of its own:

- first
- second

::: inner
Nested one level.
:::
::::

## Annotations

Text with ++a sidenote|the note body++ in it, and !!a marginal note|its body!! too.

@ A right sidebar @

$ A left sidebar $

## Tables

| Left | Centre | Right |
|:-----|:------:|------:|
| a    | b      | c     |
| d    | e      | f     |

## Footnotes, definitions, tasks

A sentence with a footnote.[^first]

[^first]: The footnote body.

Term
: Its definition.

- [ ] An open task
- [x] A done task

## Inline extensions

Press <kbd>Ctrl</kbd> or [[Ctrl+S]], ==mark== this, H~2~O and x^2^, :smile:, ~~gone~~.

*[HTML]: HyperText Markup Language

An abbreviation: HTML.

A paragraph with a class. {.lead}

A [styled span]{#s1 .accent style="color: red"} and [a second one]{class="a b"} in one paragraph.

A class on its own line under the paragraph
{.aside}

- A list
- with a class
{.checklist}

+ A list item with a class {.done}
+ and one without

> A quote with a class
> {.pull}

> A quote whose class stands lazily
{.pull-lazy}

| Table | with a class right under it |
| ----- | --------------------------- |
| a     | b                           |
{.line-table}

| Table | with a class after a blank line |
| ----- | ------------------------------- |
| c     | d                               |

{.blank-table}

An autolinked URL https://example.com/path and an angle one <https://example.org>.

![An image](images/logo.png "Logo")

A [reference link][ref] to somewhere.

[ref]: https://example.net/ref

## Lists

- Outer item
  - Inner item
    - Innermost item
- Second outer item

* A star list

1. First
2. Second
   1. Nested ordered

3) Parenthesis delimiter

> A quote
> > nested inside

    indented code block

~~~python
print("tilde fence")
~~~

```js {.numbered}
const fenced = true;
```

***
