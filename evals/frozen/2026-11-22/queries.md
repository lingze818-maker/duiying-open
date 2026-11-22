# 冻结查询集（34 条）

冻结日 2026-11-22（Asia/Shanghai）。评测时钟钉在 2026-11-15 12:00 Asia/Shanghai。默认 `k=10`，默认开启联想扩散，向量关闭。本文件与 `queries.json` 同步，以 json 为准。现行公开引擎基线为 duiying-open `c02a887`（v0.3.0）。

## 标准约定（改正后）

- **必须出现**：相关记忆应进入前 k 条。
- **绝不能出现（硬约束）**：整篇沉默（`suppress: true`）、条件沉默命中（`suppress_when`）、未授权根中的文件。泄漏率目标为 0。
- **默认开启联想扩散时**，词面无关但被扩散带进结果的、仍在授权根内的条目，一般不写入「绝不能出现」。需要核对词面噪音时，该条会显式关闭扩散（`use_links: false`）。
- 多根时核所属根；跨根不写进 links、不跨根去重。现行引擎在开启扩散时，分数可以跨根传，不把「另一根完全不得出现」写成现行 pass 标准。
- 沉默词仍用「裁员 / 编制」，未改。

## 条目

| 编号 | 查询 | 授权根 | 必须出现 | 绝不能出现 | 现行词面 | 单字回退后 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L1 | 部署 | qinglan | `qinglan/部署方案.md`<br>`qinglan/回滚演练-已发生.md` | `qinglan/草稿-已归档沉默.md`<br>`unauthorized/外人笔记.md` | `pass` | `ranking_of_lexical_hits_unchanged` | 正常词面查询对照。单字回退落地后，本条词面命中的相对排序不得变。 |
| L2 | 樱花 | qinglan | `qinglan/樱花苗圃.md` | `qinglan/草稿-已归档沉默.md`<br>`unauthorized/外人笔记.md` | `pass` | `ranking_of_lexical_hits_unchanged` | 默认开启联想扩散时，词面无关但被扩散带出的在授权根内条目不写入 must_not。本条只锁樱花苗圃必须出现，以及沉默稿与范围外文件不得出现。 |
| L3 | 散步 | qinglan | `qinglan/散步记录.md` | `qinglan/草稿-已归档沉默.md` | `pass` | `ranking_of_lexical_hits_unchanged` | 与 #13 笔记中的正常查询对照。must_not 只保留硬约束（沉默稿）；部署方案等可能被扩散带出，不作为现行引擎失败。 |
| L4 | 福利方案 | qinglan | `qinglan/福利方案.md` | `qinglan/草稿-已归档沉默.md`<br>`unauthorized/外人笔记.md` | `pass` | `ranking_of_lexical_hits_unchanged` | 查询「福利方案」不会触发编制调整.md 的 suppress_when。默认扩散下该篇可能作为邻居出现，不写入 must_not；沉默稿仍不得出现。 |
| L5 | 苗圃浇水 | qinglan | `qinglan/樱花苗圃.md` | `qinglan/草稿-已归档沉默.md`<br>`unauthorized/外人笔记.md` | `pass` | `ranking_of_lexical_hits_unchanged` | 同 L2：默认扩散下不把部署方案写入 must_not。 |
| L6 | 回滚 | qinglan | `qinglan/部署方案.md`<br>`qinglan/回滚演练-已发生.md` | `qinglan/草稿-已归档沉默.md`<br>`unauthorized/外人笔记.md` | `pass` | `ranking_of_lexical_hits_unchanged` | — |
| L7 | 青岚浇灌 | qinglan | `qinglan/樱花苗圃.md` | `lumen/流光校准.md`<br>`unauthorized/外人笔记.md` | `pass` | `ranking_of_lexical_hits_unchanged` | 主根专属锚点，授权仅 qinglan 时不得落到其他根。 |
| L8 | 部署方案 | qinglan | `qinglan/部署方案.md` | `qinglan/草稿-已归档沉默.md`<br>`unauthorized/外人笔记.md` | `pass` | `ranking_of_lexical_hits_unchanged` | — |
| S1 | 头疼 | qinglan | `qinglan/偏头痛.md`<br>`qinglan/季节感冒.md` | `qinglan/码头值班.md`<br>`qinglan/心情备忘.md`<br>`qinglan/草稿-已归档沉默.md`<br>`unauthorized/外人笔记.md` | `pass` | `ranking_of_lexical_hits_unchanged` | （关闭扩散）查询写「头疼」，夹具只写「头痛」。现行公开引擎已有同义词表 头疼↔头痛，本条在现行基线应为 pass（不是零召回）。单字回退只在 bigram 零命中时才补一轮，本条已有词面/同义词命中，落地后相对排序不得变，也不应被标成「按单字近似匹配」。本条关闭联想扩散，以便核对仅含「头」的码头值班.md 不得算词面命中。 |
| S2 | 头痛 | qinglan | `qinglan/偏头痛.md`<br>`qinglan/季节感冒.md` | `qinglan/码头值班.md`<br>`qinglan/草稿-已归档沉默.md` | `pass` | `still_exact_no_unigram_note` | （关闭扩散）精确词面命中，不应走单字回退，也不应被标成近似匹配。关闭扩散，以便核对码头值班.md 不得算命中。 |
| S3 | 快乐 | qinglan | `qinglan/心情备忘.md` | `qinglan/草稿-已归档沉默.md`<br>`unauthorized/外人笔记.md` | `expected_miss` | `expected_miss` | （关闭扩散）夹具只写「开心」，正文不再出现「快乐」。完全异字近义，同义词表与单字回退都救不了；本条留给以后的向量对照，现在零召回不算失败。关闭扩散，避免邻居分数造成假命中。 |
| S4 | 开心 | qinglan | `qinglan/心情备忘.md` | `qinglan/草稿-已归档沉默.md`<br>`unauthorized/外人笔记.md` | `pass` | `ranking_of_lexical_hits_unchanged` | 与 S3 对照：精确词面「开心」现在就应命中。默认扩散下不把偏头痛写入 must_not。 |
| S5 | 感冒 | qinglan | `qinglan/季节感冒.md` | `qinglan/码头值班.md` | `pass` | `ranking_of_lexical_hits_unchanged` | （关闭扩散） |
| S6 | 头疼 | qinglan | `qinglan/偏头痛.md` | `qinglan/码头值班.md` | `pass` | `ranking_of_lexical_hits_unchanged` | （关闭扩散）与 S1 互补。现行基线已能经同义词表召回偏头痛.md。单字回退落地后若带进噪音，相关条仍须排在仅共享单字的噪音之前；现行基线先关闭扩散，核对码头值班.md 不得出现。 |
| T1 | 部署回滚 | qinglan | `qinglan/回滚演练-已发生.md`<br>`qinglan/回滚演练-计划.md`<br>`qinglan/回滚演练-更早.md` | `qinglan/草稿-已归档沉默.md` | `pass` | `ranking_of_lexical_hits_unchanged` | 不锁「计划」与「更早」之间的名次，避免把未写死的公式写进标准答案。 |
| T2 | 最近 | qinglan | `qinglan/回滚演练-已发生.md`<br>`qinglan/周报.md`<br>`qinglan/部署方案.md` | `qinglan/草稿-已归档沉默.md` | `pass` | `unchanged` | 只有时间词时按记忆发生日列出；suppress:true 仍不得出现。未来日期条目若被列出，不得排到已发生的近因之前。 |
| T3 | 最近的樱花 | qinglan | `qinglan/樱花苗圃.md` | `qinglan/草稿-已归档沉默.md`<br>`unauthorized/外人笔记.md` | `pass` | `ranking_of_lexical_hits_unchanged` | 带词面的时间查询不得改走「只按发生日列出」：樱花苗圃必须出现。回滚演练-已发生可能被扩散带出，不作为 must_not；以必须出现樱花苗圃、且结果不得与 T2 的纯时间列表相同来核对。 |
| T4 | 最近的部署回滚 | qinglan | `qinglan/回滚演练-已发生.md` | `qinglan/草稿-已归档沉默.md` | `pass` | `ranking_of_lexical_hits_unchanged` | — |
| G1 | 裁员方案 | qinglan | — | `qinglan/编制调整.md` | `pass` | `leakage_still_zero` | 编制调整.md 使用多行 suppress_when：裁员、编制。查询含「裁员」时泄漏率必须为 0。本条没有必须出现的条目。 |
| G2 | 编制 | qinglan | — | `qinglan/编制调整.md` | `pass` | `leakage_still_zero` | — |
| G3 | 工作站电源 | qinglan | `qinglan/编制调整.md` | `qinglan/草稿-已归档沉默.md` | `pass` | `ranking_of_lexical_hits_unchanged` | 同一篇在查询不含沉默词时应出现，证明沉默是条件触发，不是整篇删除。 |
| G4 | 部署 | qinglan | `qinglan/部署方案.md` | `qinglan/草稿-已归档沉默.md` | `pass` | `leakage_still_zero` | 整篇 suppress:true，即使正文含「部署方案」也不得浮出。 |
| G5 | 部署方案 | qinglan | `qinglan/notes/决策记录.md`<br>`qinglan/旧版决策.md` | `qinglan/草稿-已归档沉默.md` | `pass` | `ranking_of_lexical_hits_unchanged` | 子目录且 basename 唯一：notes/决策记录.md 应排在旧版决策.md 之前，旧版决策不得消失。现行引擎未必给旧版决策附上提到「决策记录.md」的说明，这一条记为已知缺口，不写入现行 pass 标准。 |
| G6 | 纪要 | qinglan | `qinglan/east/纪要.md`<br>`qinglan/west/纪要.md` | `qinglan/草稿-已归档沉默.md`<br>`unauthorized/外人笔记.md` | `pass` | `unchanged` | 同根歧义：east/纪要.md 与 west/纪要.md 同名。旧纪要.md 不得被猜指向其中一篇；doctor 应报坏链并提示写相对路径。单根时 doctor 的 file 字段是「旧纪要.md」，不含根名前缀。 |
| G7 | 你好 | qinglan | — | `qinglan/部署方案.md`<br>`qinglan/草稿-已归档沉默.md` | `pass` | `unchanged` | 浮现门：问候零条。 |
| G8 | 记得上次部署 | qinglan | `qinglan/部署方案.md` | `qinglan/草稿-已归档沉默.md` | `pass` | `unchanged` | 浮现门：回忆类查询应放行词面命中。 |
| M1 | 流光校准 | qinglan, lumen | `lumen/流光校准.md` | `qinglan/草稿-已归档沉默.md`<br>`unauthorized/外人笔记.md` | `pass` | `unchanged` | 现行引擎在默认联想扩散下，分数可跨根扩散，其他根文档可能出现在结果里。本条只要求流光校准必须出现且归属 lumen，以及沉默稿与范围外文件不得出现；不把青岚条目写成现行 must_not。跨根不写进 links 仍由 M3 核对。 |
| M2 | 青岚浇灌 | qinglan, lumen | `qinglan/樱花苗圃.md` | `qinglan/草稿-已归档沉默.md`<br>`unauthorized/外人笔记.md` | `pass` | `unchanged` | 同 M1：只锁青岚浇灌（樱花苗圃）必须出现；不把流光档案条目写成现行 must_not。 |
| M3 | 部署 | qinglan, lumen | `qinglan/周报.md`<br>`lumen/周报.md`<br>`qinglan/部署方案.md`<br>`lumen/部署方案.md` | `unauthorized/外人笔记.md` | `pass` | `unchanged` | （k=20）同名文件各属其根，不串附注、不跨根去重。本条 k=20：默认 k=10 时，部署类条目较多，lumen/周报.md 可能被挤出前十，不因此判引擎失败。 |
| O1 | 柘林徽记 | qinglan, lumen | — | `unauthorized/外人笔记.md` | `pass` | `leakage_still_zero` | 范围外专属锚点改为「柘林徽记」。初稿曾用「紫藤口令」，但授权根部署方案.md 写有「不依赖临时口令」，词面「口令」会命中授权根，零召回被误判失败。本条仍要求授权根为 qinglan+lumen 时结果总数为 0，外人笔记不得出现。 |
| O2 | 部署 | qinglan | `qinglan/部署方案.md` | `unauthorized/外人笔记.md`<br>`lumen/部署方案.md`<br>`lumen/周报.md`<br>`lumen/流光校准.md` | `pass` | `leakage_still_zero` | 外人笔记与流光档案都写了「部署」，但本条只授权 qinglan。 |
| O3 | 流光校准 | qinglan | — | `lumen/流光校准.md` | `pass` | `leakage_still_zero` | 有效根未授权时等同范围外。 |
| R1 | 蓝图 归档 | qinglan | `qinglan/蓝图归档纪要.md` | `qinglan/草稿-已归档沉默.md` | `pass` | `unchanged` | 开启词面重排：同时写到两个词的纪要应排到堆词诱饵之前。 |
| R2 | 蓝图 归档 | qinglan | `qinglan/堆词诱饵.md` | `qinglan/草稿-已归档沉默.md` | `pass` | `unchanged` | 关闭词面重排的对照：堆词诱饵应排在前面。不是默认路径，只用于开/关对照。 |

## 需要单独核对的约束

- **T1 / T4**：`回滚演练-已发生.md` 必须排在 `回滚演练-计划.md` 之前；T1 还要求已发生排在 `回滚演练-更早.md` 之前。不锁计划与更早之间的名次。
- **T2**：只有「最近」时按记忆发生日列出；`草稿-已归档沉默.md` 仍不得出现。
- **T3**：带词面的时间查询须召回樱花苗圃，不得改走「只按发生日列出」。
- **G5**：`notes/决策记录.md` 须排在 `旧版决策.md` 之前，旧版不得消失。现行 search 在 `superseded_by` 只写 basename、目标在子目录时，结果往往不附注；这一点记为已知缺口，不写入现行 pass。
- **G6**：`旧纪要.md` 不得被猜指向 east 或 west 的 `纪要.md`；doctor 应报「多个同名」坏链。单根时 doctor 的 file 字段是 `旧纪要.md`，不含根名前缀。
- **M3**：两根下的同名 `周报.md` / `部署方案.md` 都要出现，并带正确的 root；不跨根去重、不串附注。本条 `k=20`。
- **S1 / S6**：现行公开引擎已有同义词表「头疼 ↔ 头痛」，现行基线应为 pass，不是零召回。单字回退只在 bigram 零命中时才补一轮，这两条已有词面/同义词命中，落地后相对排序不得变。关闭扩散后，`码头值班.md` 不得算命中。
- **S3**：`快乐` → `心情备忘.md`（正文只有「开心」）在词面两套基线都允许零召回，待向量对照。
- **O1**：范围外专属锚点是「柘林徽记」（不再用「紫藤口令」）。授权根为 qinglan+lumen 时结果总数须为 0。
- **R1 / R2**：同一查询，开重排时纪要在前，关重排时堆词诱饵在前。

## 改正后仍请过眼的点

1. 虚构世界仍是「青岚工坊 / 流光档案」。夹具里原先写给评测看的说明句已删掉，改成更像日常笔记的正文；请再看一眼有没有不像笔记、或不适合进公开仓的句子。
2. 「头疼 → 头痛」现行即可通过同义词表召回；「开心 / 快乐」仍留作向量待办。
3. 沉默词仍用「裁员 / 编制」。
4. 范围外锚点从「紫藤口令」改成了「柘林徽记」，条目数仍是 34 条。

